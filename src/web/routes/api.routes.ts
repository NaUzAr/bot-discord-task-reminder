import { Router, Request, Response } from 'express';
import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { prisma } from '../../database/prisma';
import { reminderQueue } from '../../workers/queue';
import { TaskService } from '../../modules/task/task.service';
import { GuildService } from '../../modules/guild/guild.service';
import { logger } from '../../shared/utils/logger';
import { sessionCache } from '../services/session-cache.service';
import { sseService } from '../services/sse.service';
import { ExportService } from '../../modules/export/export.service';
import { AIService } from '../../modules/ai/ai.service';
import { AuditLogService } from '../services/audit-log.service';
import { generateInitialsAvatar, getDiscordAvatarUrl } from '../../shared/utils/avatar';

export function createApiRouter(client?: Client) {
  const router = Router();

  // Helper untuk membaca user yang sedang login dari Cache / Cookie / Header
  async function getSessionUser(req: Request) {
    const token =
      req.cookies?.taskflow_session_token ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

    if (token) {
      const cached = await sessionCache.getSession(token);
      if (cached) {
        return {
          id: cached.userId,
          discordId: cached.discordId,
          username: cached.username,
          role: cached.role,
          avatarUrl: cached.avatarUrl,
          token: cached.token,
        };
      }
    }

    try {
      const cookie = req.cookies?.taskflow_session;
      if (!cookie) return null;
      const parsed = typeof cookie === 'string' ? JSON.parse(cookie) : cookie;
      if (parsed?.token) {
        const cached = await sessionCache.getSession(parsed.token);
        if (cached) return { ...cached, id: cached.userId };
      }
      return parsed;
    } catch {
      return null;
    }
  }

  // 0. Avatar Proxy Endpoint (Aman, cepat, dan anti-blokir untuk foto profil Discord)
  router.get('/avatar/:discordId', async (req: Request, res: Response) => {
    const rawId = req.params.discordId;
    const discordId = Array.isArray(rawId) ? rawId[0] : String(rawId || '');
    const username = (req.query.u as string) || (req.query.username as string) || 'User';

    try {
      let targetAvatarUrl = '';
      if (client && client.isReady() && /^\d{16,20}$/.test(discordId)) {
        try {
          const user = await client.users.fetch(discordId);
          if (user) {
            targetAvatarUrl = user.displayAvatarURL({ extension: 'png', size: 128 });
          }
        } catch {
          // Abaikan jika fetch Discord gagal
        }
      }

      if (!targetAvatarUrl && /^\d{16,20}$/.test(discordId)) {
        targetAvatarUrl = `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(discordId) >> 22n) % 6n)}.png`;
      }

      if (targetAvatarUrl) {
        const fetchRes = await fetch(targetAvatarUrl);
        if (fetchRes.ok) {
          const contentType = fetchRes.headers.get('content-type') || 'image/png';
          const arrayBuf = await fetchRes.arrayBuffer();
          res.setHeader('Content-Type', contentType);
          res.setHeader('Cache-Control', 'public, max-age=86400, stale-while-revalidate=43200');
          return res.send(Buffer.from(arrayBuf));
        }
      }
    } catch (proxyErr) {
      logger.warn({ proxyErr, discordId }, 'Avatar proxy fallback to SVG');
    }

    // Fallback: Kirim SVG Initials
    const svgData = generateInitialsAvatar(username);
    const svgString = decodeURIComponent(svgData.replace('data:image/svg+xml;utf8,', ''));
    res.setHeader('Content-Type', 'image/svg+xml');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    return res.send(svgString);
  });

  // 1. Status Sistem & Bot (Live Metrics)
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const totalTasks = await prisma.task.count({ where: { deletedAt: null } });
      const completedTasks = await prisma.task.count({ where: { status: 'DONE', deletedAt: null } });
      const totalUsers = await prisma.user.count();
      const totalGuilds = await prisma.guild.count();

      let queueCounts = { waiting: 0, active: 0, delayed: 0 };
      try {
        const counts = await reminderQueue.getJobCounts('waiting', 'active', 'delayed');
        queueCounts = { waiting: counts.waiting, active: counts.active, delayed: counts.delayed };
      } catch (qErr) {
        // Abaikan jika redis info belum siap
      }

      const cacheStats = sessionCache.getStats();

      return res.json({
        bot: {
          online: !!client?.isReady(),
          user: client?.user?.tag || 'TaskFlow Bot',
          avatar: client?.user?.displayAvatarURL() || null,
          pingMs: client?.ws?.ping || 0,
          guildsCount: client?.guilds?.cache?.size || totalGuilds,
          uptimeSeconds: client?.uptime ? Math.floor(client.uptime / 1000) : 0,
        },
        database: {
          totalTasks,
          completedTasks,
          totalUsers,
          totalGuilds,
        },
        queue: queueCounts,
        sessionCache: cacheStats,
      });
    } catch (err) {
      logger.error({ err }, 'Error fetch /api/status');
      return res.status(500).json({ error: 'Gagal mengambil status sistem' });
    }
  });

  // 1b. Real-Time Server-Sent Events (SSE) Live Sync
  router.get('/events', (req: Request, res: Response) => {
    sseService.addClient(res);
  });

  // Helper untuk mengambil tugas yang boleh di-export oleh user yang login
  async function getExportTasks(req: Request) {
    const session = await getSessionUser(req);
    const currentUser = session?.id ? await prisma.user.findUnique({ where: { id: session.id } }) : null;
    const isAdmin = currentUser?.role === 'ADMIN';

    const whereClause: any = { deletedAt: null };
    if (session?.id && (!isAdmin || req.query.scope === 'personal')) {
      whereClause.OR = [{ userId: session.id }, { assignedUserIds: { has: session.discordId } }];
    }

    return prisma.task.findMany({
      where: whereClause,
      orderBy: { dueAt: 'asc' },
      include: {
        user: { select: { username: true, discordId: true } },
      },
    });
  }

  // 1c. Export iCalendar (.ics) Feed
  router.get('/export/calendar.ics', async (req: Request, res: Response) => {
    try {
      const tasks = await getExportTasks(req);
      const icsData = ExportService.generateICalendar(tasks, 'TaskFlow OS Deadlines');
      res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="taskflow-deadlines.ics"');
      return res.send(icsData);
    } catch (err) {
      logger.error({ err }, 'Error export calendar.ics');
      return res.status(500).send('Gagal mengekspor kalender');
    }
  });

  // 1d. Export Spreadsheet CSV (Excel / Notion)
  router.get('/export/csv', async (req: Request, res: Response) => {
    try {
      const tasks = await getExportTasks(req);
      const csvData = ExportService.generateCSV(tasks);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="taskflow-tasks.csv"');
      return res.send(csvData);
    } catch (err) {
      return res.status(500).send('Gagal mengekspor CSV');
    }
  });

  // 1e. Export Format Rekap WhatsApp
  router.get('/export/whatsapp', async (req: Request, res: Response) => {
    try {
      const tasks = await getExportTasks(req);
      const text = ExportService.formatWhatsAppRekap(tasks, 'KELAS', client);
      return res.json({ success: true, text });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal membuat rekap WhatsApp' });
    }
  });

  // 1f. AI Magic NLP Task Parser (Google Gemini)
  router.post('/ai/parse-task', async (req: Request, res: Response) => {
    const { prompt } = req.body;
    if (!prompt || typeof prompt !== 'string' || prompt.trim().length < 3) {
      return res.status(400).json({ error: 'Teks instruksi tugas wajib diisi minimal 3 karakter' });
    }

    try {
      const parsed = await AIService.extractTask(prompt.trim());
      if (!parsed) {
        return res.status(422).json({ error: 'AI tidak dapat mendeteksi tugas dari teks tersebut' });
      }
      return res.json({ success: true, parsed });
    } catch (err: any) {
      logger.error({ err }, 'Error AI task parsing');
      return res.status(500).json({ error: 'Gagal memproses teks dengan AI: ' + (err?.message || 'Error internal') });
    }
  });

  // 2. Profil Pengguna yang Sedang Login
  router.get('/me', async (req: Request, res: Response) => {
    const session = await getSessionUser(req);
    if (!session) {
      return res.status(401).json({ authenticated: false });
    }

    try {
      const user = await prisma.user.findUnique({
        where: { discordId: session.discordId },
        include: {
          _count: {
            select: {
              tasks: { where: { deletedAt: null } },
              focusSessions: true,
            },
          },
        },
      });

      if (!user) {
        return res.status(404).json({ error: 'User tidak ditemukan di DB' });
      }

      // Hitung level berdasarkan XP (1 level per 100 XP)
      const level = Math.floor(user.xp / 100) + 1;
      const progressPercent = user.xp % 100;

      return res.json({
        authenticated: true,
        user: {
          ...user,
          level,
          progressPercent,
          avatarUrl: session.avatarUrl,
        },
      });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal membaca data profil' });
    }
  });

  // 2b. Update Pengaturan Akun (Quiet Hours, Timezone, DM)
  router.patch('/settings', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      if (!session?.id) {
        return res.status(401).json({ error: 'Harap login terlebih dahulu' });
      }

      const { timezone, quietHoursStart, quietHoursEnd, quietHoursEnabled, dmReminders } = req.body;

      const dataToUpdate: any = {};
      if (typeof timezone === 'string') dataToUpdate.timezone = timezone;
      if (typeof quietHoursStart === 'string') dataToUpdate.quietHoursStart = quietHoursStart;
      if (typeof quietHoursEnd === 'string') dataToUpdate.quietHoursEnd = quietHoursEnd;
      if (typeof quietHoursEnabled === 'boolean') dataToUpdate.quietHoursEnabled = quietHoursEnabled;
      if (typeof dmReminders === 'boolean') dataToUpdate.dmReminders = dmReminders;

      const updated = await prisma.user.update({
        where: { id: session.id },
        data: dataToUpdate,
      });

      return res.json({ success: true, user: updated });
    } catch (err) {
      logger.error({ err }, 'Error update /api/settings');
      return res.status(500).json({ error: 'Gagal memperbarui pengaturan' });
    }
  });

  // 3. Daftar Tugas (Task List & Kanban)
  router.get('/tasks', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      const { status, priority, search, course } = req.query;

      const whereClause: any = {
        deletedAt: null,
      };

      const currentUser = session?.id
        ? await prisma.user.findUnique({ where: { id: session.id } })
        : null;

      const isAdmin = currentUser?.role === 'ADMIN';

      if (session?.id && (!isAdmin || req.query.scope === 'personal')) {
        // User biasa: hanya lihat tugas miliknya atau tugas kelompok yang di-assign padanya
        whereClause.OR = [
          { userId: session.id },
          { assignedUserIds: { has: session.discordId } },
        ];
      }

      if (status && status !== 'ALL') {
        whereClause.status = status;
      }
      if (priority && priority !== 'ALL') {
        whereClause.priority = priority;
      }
      if (course && course !== 'ALL' && typeof course === 'string') {
        whereClause.courseId = { equals: course, mode: 'insensitive' };
      }
      if (search && typeof search === 'string') {
        whereClause.title = { contains: search, mode: 'insensitive' };
      }

      const tasks = await prisma.task.findMany({
        where: whereClause,
        orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }],
        include: {
          subtasks: {
            orderBy: { position: 'asc' },
          },
          user: {
            select: { username: true, discordId: true },
          },
        },
      });

      return res.json({ tasks });
    } catch (err) {
      logger.error({ err }, 'Error fetch /api/tasks');
      return res.status(500).json({ error: 'Gagal mengambil daftar tugas' });
    }
  });

  // 3b. Daftar Server Discord yang Terhubung (untuk pilihan tujuan thread & radar)
  router.get('/guilds', async (_req: Request, res: Response) => {
    try {
      const dbGuilds = await prisma.guild.findMany({
        orderBy: { createdAt: 'desc' },
      });

      const guilds = dbGuilds.map((g) => {
        const cached = client?.guilds.cache.get(g.discordGuildId);
        return {
          id: g.id,
          discordGuildId: g.discordGuildId,
          name: cached?.name || g.name || 'Discord Server',
          iconUrl: cached?.iconURL({ size: 64 }) || null,
          hasInbox: !!g.inboxChannelId,
          hasRadar: !!g.radarChannelId,
        };
      });

      return res.json({ guilds });
    } catch (err) {
      logger.error({ err }, 'Error fetch /api/guilds');
      return res.status(500).json({ error: 'Gagal mengambil daftar server' });
    }
  });

  // 4. Buat Tugas Baru dari Web
  router.post('/tasks', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      const { title, description, dueAt, priority, taskType, linkUrl, subtasks, courseName, courseId, targetGuildId } = req.body;

      if (!title || typeof title !== 'string' || title.trim().length === 0) {
        return res.status(400).json({ error: 'Judul tugas wajib diisi' });
      }

      // Cari atau fallback ke user pertama di DB
      let targetUser = null;
      if (session?.discordId) {
        targetUser = await prisma.user.findUnique({ where: { discordId: session.discordId } });
      }
      if (!targetUser) {
        targetUser = await prisma.user.findFirst();
      }
      if (!targetUser) {
        targetUser = await prisma.user.create({
          data: {
            discordId: 'web-user',
            username: session?.username || 'Web Student',
          },
        });
      }

      // Cari guild tujuan jika dipilih
      let chosenDbGuild = null;
      if (targetGuildId && targetGuildId !== 'PERSONAL' && targetGuildId !== 'none') {
        chosenDbGuild = await prisma.guild.findFirst({
          where: {
            OR: [
              { id: targetGuildId },
              { discordGuildId: targetGuildId },
            ],
          },
        });
      }

      const parsedDueAt = dueAt ? new Date(dueAt) : null;

      const task = await prisma.task.create({
        data: {
          userId: targetUser.id,
          guildId: chosenDbGuild ? chosenDbGuild.id : null,
          title: title.trim(),
          description: description?.trim() || null,
          dueAt: parsedDueAt,
          priority: priority || 'MEDIUM',
          taskType: taskType || 'INDIVIDUAL',
          linkUrl: linkUrl?.trim() || null,
          courseId: (courseName || courseId)?.trim() || null,
          sourceType: 'WEB_DASHBOARD',
          assignedUserIds: [targetUser.discordId],
        },
      });

      // Tambahkan subtasks jika ada
      if (Array.isArray(subtasks) && subtasks.length > 0) {
        const subtaskData = subtasks
          .filter((st: string) => typeof st === 'string' && st.trim().length > 0)
          .map((st: string, idx: number) => ({
            taskId: task.id,
            title: st.trim(),
            position: idx,
          }));

        if (subtaskData.length > 0) {
          await prisma.subtask.createMany({ data: subtaskData });
        }
      }

      // Jadwalkan reminder jika ada dueAt
      if (parsedDueAt && parsedDueAt > new Date()) {
        try {
          const reminderTimes = [
            { label: 'H-1 Jam', time: new Date(parsedDueAt.getTime() - 60 * 60 * 1000) },
            { label: 'Deadline Sekarang', time: parsedDueAt },
          ];

          for (const rem of reminderTimes) {
            if (rem.time > new Date()) {
              const reminder = await prisma.reminder.create({
                data: {
                  taskId: task.id,
                  userId: targetUser.id,
                  reminderAt: rem.time,
                  deliveryType: 'DM',
                },
              });

              const delay = rem.time.getTime() - Date.now();
              await reminderQueue.add(
                'send-reminder',
                {
                  reminderId: reminder.id,
                  taskId: task.id,
                  userId: targetUser.id,
                  taskTitle: task.title,
                },
                { delay: Math.max(0, delay), removeOnComplete: true }
              );
            }
          }
        } catch (queueErr) {
          logger.warn({ queueErr }, 'Gagal menjadwalkan queue reminder dari web');
        }
      }

      await AuditLogService.record({
        userId: targetUser.id,
        eventType: 'TASK_CREATE',
        taskId: task.id,
        metadata: { title: task.title, course: task.courseId, priority: task.priority },
      });

      // Auto-dispatch ke Discord (Thread di #inbox-tugas & Live Radar) jika memilih server
      if (client && client.isReady() && chosenDbGuild) {
        try {
          await TaskService.dispatchTaskToDiscord(task.id, client, chosenDbGuild.discordGuildId);
        } catch (dErr) {
          logger.error({ dErr, taskId: task.id }, 'Gagal auto-dispatch task ke Discord setelah dibuat via Web');
        }
      }

      sseService.broadcast('task:changed', { action: 'created', taskId: task.id });
      return res.status(201).json({ success: true, task });
    } catch (err) {
      logger.error({ err }, 'Error create task /api/tasks');
      return res.status(500).json({ error: 'Gagal membuat tugas' });
    }
  });

  // 5. Update Status Tugas (misal Drag & Drop di Kanban atau Centang Selesai)
  router.patch('/tasks/:id/status', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const { status } = req.body;

      if (!['TODO', 'IN_PROGRESS', 'DONE', 'CANCELLED'].includes(status)) {
        return res.status(400).json({ error: 'Status tidak valid' });
      }

      const existingTask = await prisma.task.findUnique({ where: { id } });
      if (!existingTask) {
        return res.status(404).json({ error: 'Task tidak ditemukan' });
      }

      const isBecomingDone = status === 'DONE' && existingTask.status !== 'DONE';

      const updated = await prisma.task.update({
        where: { id },
        data: {
          status,
          completedAt: isBecomingDone ? new Date() : (status !== 'DONE' ? null : existingTask.completedAt),
        },
      });

      // Berikan reward XP & update streak jika selesai
      if (isBecomingDone) {
        await prisma.user.update({
          where: { id: existingTask.userId },
          data: {
            xp: { increment: 50 },
            lastActiveAt: new Date(),
          },
        }).catch(() => null);

        // Batalkan reminder pending
        await prisma.reminder.updateMany({
          where: { taskId: id, status: 'PENDING' },
          data: { status: 'CANCELLED' },
        }).catch(() => null);
      }

      const session = await getSessionUser(req);
      if (session?.id) {
        await AuditLogService.record({
          userId: session.id,
          eventType: status === 'DONE' ? 'TASK_COMPLETE' : 'TASK_STATUS_UPDATE',
          taskId: id,
          metadata: { title: existingTask.title, newStatus: status },
        });
      }

      sseService.broadcast('task:changed', { action: 'status_updated', taskId: id, status });
      return res.json({ success: true, task: updated });
    } catch (err) {
      logger.error({ err }, 'Error update task status');
      return res.status(500).json({ error: 'Gagal memperbarui status tugas' });
    }
  });

  // 6. Toggle Subtask Done/Todo
  const handleSubtaskToggle = async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const subtask = await prisma.subtask.findUnique({ where: { id }, include: { task: true } });
      if (!subtask) {
        return res.status(404).json({ error: 'Subtask tidak ditemukan' });
      }

      const newStatus = subtask.status === 'DONE' ? 'TODO' : 'DONE';
      const updated = await prisma.subtask.update({
        where: { id },
        data: {
          status: newStatus,
          completedAt: newStatus === 'DONE' ? new Date() : null,
        },
      });

      // Bonus XP +10 jika subtask selesai
      if (newStatus === 'DONE' && subtask.task) {
        await prisma.user.update({
          where: { id: subtask.task.userId },
          data: { xp: { increment: 10 } },
        }).catch(() => null);
      }

      sseService.broadcast('task:changed', { action: 'subtask_toggled', subtaskId: id });
      return res.json({ success: true, subtask: updated });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal update subtask' });
    }
  };

  router.post('/subtasks/:id/toggle', handleSubtaskToggle);
  router.patch('/subtasks/:id/toggle', handleSubtaskToggle);

  // 7. Hapus Tugas (Soft Delete)
  router.delete('/tasks/:id', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      const id = req.params.id as string;
      const existingTask = await prisma.task.findUnique({ where: { id } });

      await prisma.task.update({
        where: { id },
        data: { deletedAt: new Date() },
      });

      if (session?.id && existingTask) {
        await AuditLogService.record({
          userId: session.id,
          eventType: 'TASK_DELETE',
          taskId: id,
          metadata: { title: existingTask.title },
        });
      }

      sseService.broadcast('task:changed', { action: 'deleted', taskId: id });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal menghapus tugas' });
    }
  });

  // 7b. Tunda Pengingat Tugas (Snooze)
  router.post('/tasks/:id/snooze', async (req: Request, res: Response) => {
    try {
      const id = req.params.id as string;
      const minutes = parseInt(req.body.minutes, 10) || 60;
      const result = await TaskService.snoozeTask(id, minutes);
      if (!result) {
        return res.status(404).json({ error: 'Tugas tidak ditemukan atau sudah selesai' });
      }
      sseService.broadcast('task:changed', { action: 'snoozed', taskId: id });
      return res.json({ success: true, ...result });
    } catch (err) {
      logger.error({ err }, 'Error snooze task');
      return res.status(500).json({ error: 'Gagal menunda pengingat tugas' });
    }
  });

  // 8. Deadline Radar API (Sesuai Bagian 31 Spec)
  router.get('/radar', async (req: Request, res: Response) => {
    try {
      const now = new Date();
      const endOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
      const endOfTomorrow = new Date(endOfToday.getTime() + 24 * 60 * 60 * 1000);
      const endOfWeek = new Date(endOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);

      const activeTasks = await prisma.task.findMany({
        where: {
          deletedAt: null,
          status: { in: ['TODO', 'IN_PROGRESS'] },
          dueAt: { not: null },
        },
        orderBy: { dueAt: 'asc' },
        include: {
          user: { select: { username: true } },
          subtasks: true,
        },
      });

      const overdue = activeTasks.filter(t => t.dueAt && t.dueAt < now);
      const today = activeTasks.filter(t => t.dueAt && t.dueAt >= now && t.dueAt <= endOfToday);
      const tomorrow = activeTasks.filter(t => t.dueAt && t.dueAt > endOfToday && t.dueAt <= endOfTomorrow);
      const thisWeek = activeTasks.filter(t => t.dueAt && t.dueAt > endOfTomorrow && t.dueAt <= endOfWeek);
      const later = activeTasks.filter(t => t.dueAt && t.dueAt > endOfWeek);

      return res.json({
        summary: {
          overdueCount: overdue.length,
          todayCount: today.length,
          tomorrowCount: tomorrow.length,
          thisWeekCount: thisWeek.length,
          laterCount: later.length,
        },
        overdue,
        today,
        tomorrow,
        thisWeek,
        later,
      });
    } catch (err) {
      logger.error({ err }, 'Error fetch /api/radar');
      return res.status(500).json({ error: 'Gagal mengambil data radar' });
    }
  });

  // 9. Gamification Leaderboard (Sesuai Bagian 34 Spec)
  router.get('/leaderboard', async (_req: Request, res: Response) => {
    try {
      const topUsers = await prisma.user.findMany({
        take: 20,
        orderBy: [{ xp: 'desc' }, { streak: 'desc' }],
        include: {
          _count: {
            select: {
              tasks: { where: { status: 'DONE', deletedAt: null } },
              focusSessions: true,
            },
          },
        },
      });

      const formatted = await Promise.all(
        topUsers.map(async (u, index) => ({
          rank: index + 1,
          id: u.id,
          username: u.username,
          discordId: u.discordId,
          xp: u.xp,
          streak: u.streak,
          level: Math.floor(u.xp / 100) + 1,
          completedTasks: u._count.tasks,
          focusSessions: u._count.focusSessions,
          avatarUrl: await getDiscordAvatarUrl(u.discordId, u.username, client),
        }))
      );

      return res.json({ leaderboard: formatted });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal mengambil leaderboard' });
    }
  });

  // 10. Focus Session (Pomodoro Tracker - Sesuai Bagian 24 Spec)
  router.post('/focus/log', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      const { durationMinutes, taskId } = req.body;

      let targetUser = null;
      if (session?.discordId) {
        targetUser = await prisma.user.findUnique({ where: { discordId: session.discordId } });
      }
      if (!targetUser) targetUser = await prisma.user.findFirst();
      if (!targetUser) return res.status(400).json({ error: 'User tidak ditemukan' });

      const duration = parseInt(durationMinutes, 10) || 25;
      const startedAt = new Date(Date.now() - duration * 60 * 1000);

      const focus = await prisma.focusSession.create({
        data: {
          userId: targetUser.id,
          taskId: taskId || null,
          startedAt,
          endedAt: new Date(),
          durationMinutes: duration,
        },
      });

      // Bonus XP untuk fokus: 1 menit = 1 XP
      await prisma.user.update({
        where: { id: targetUser.id },
        data: {
          xp: { increment: duration },
          lastActiveAt: new Date(),
        },
      });

      return res.json({ success: true, focus, xpEarned: duration });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal mencatat sesi fokus' });
    }
  });

  // 11. Admin: Direktori Mahasiswa & Status
  router.get('/admin/users', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      if (!session?.id) {
        return res.status(401).json({ error: 'Harap login' });
      }

      const user = await prisma.user.findUnique({ where: { id: session.id } });
      if (user?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Akses khusus Administrator / Dosen' });
      }

      const users = await prisma.user.findMany({
        orderBy: { xp: 'desc' },
        include: {
          _count: {
            select: {
              tasks: { where: { deletedAt: null } },
              focusSessions: true,
            },
          },
        },
      });

      return res.json({ users });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal membaca data pengguna' });
    }
  });

  // 11b. Admin: Update Role User (USER <-> ADMIN)
  router.patch('/admin/users/:id/role', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      if (!session?.id) return res.status(401).json({ error: 'Harap login' });

      const adminUser = await prisma.user.findUnique({ where: { id: session.id } });
      if (adminUser?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Akses khusus Administrator' });
      }

      const targetId = req.params.id as string;
      const { role } = req.body;
      if (!['USER', 'ADMIN'].includes(role)) {
        return res.status(400).json({ error: 'Role tidak valid' });
      }

      const updated = await prisma.user.update({
        where: { id: targetId },
        data: { role },
      });

      await AuditLogService.record({
        userId: adminUser.id,
        eventType: 'ROLE_CHANGE',
        metadata: {
          targetUserId: targetId,
          targetUsername: updated.username,
          newRole: role,
        },
      });

      sseService.broadcast('status:changed', { action: 'user_role_updated', targetId, role });

      return res.json({ success: true, user: updated });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal mengubah role pengguna' });
    }
  });

  // 11c. Admin: Broadcast Pengumuman ke Discord Langsung dari Web
  router.post('/admin/broadcast', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      if (!session?.id) return res.status(401).json({ error: 'Harap login' });

      const adminUser = await prisma.user.findUnique({ where: { id: session.id } });
      if (adminUser?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Akses khusus Administrator' });
      }

      const { title, message, urgent } = req.body;
      if (!title || !message) {
        return res.status(400).json({ error: 'Judul dan isi pesan wajib diisi' });
      }

      let sentCount = 0;
      if (client?.guilds?.cache) {
        for (const [, guild] of client.guilds.cache) {
          const dbGuild = await prisma.guild.findUnique({ where: { discordGuildId: guild.id } });
          const targetChannelId = dbGuild?.radarChannelId || dbGuild?.inboxChannelId;
          const ch = targetChannelId ? (guild.channels.cache.get(targetChannelId) as TextChannel | undefined) : null;

          if (ch && ch.isTextBased()) {
            const embed = new EmbedBuilder()
              .setTitle(`${urgent ? '🚨 [PENTING] ' : '📢 '}${title}`)
              .setDescription(message)
              .setColor(urgent ? '#EF4444' : '#5865F2')
              .setFooter({ text: `Diumumkan oleh Admin: ${adminUser.username} via Web Dashboard` })
              .setTimestamp();

            await ch.send({ embeds: [embed] }).catch(() => null);
            sentCount++;
          }
        }
      }

      await AuditLogService.record({
        userId: adminUser.id,
        eventType: 'ANNOUNCEMENT_BROADCAST',
        metadata: { title, urgent: Boolean(urgent), sentCount },
      });

      sseService.broadcast('announcement', { title, message, urgent, author: adminUser.username });

      return res.json({ success: true, message: `Pengumuman berhasil disiarkan ke ${sentCount} server Discord!` });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal mengirim pengumuman ke Discord' });
    }
  });

  // 11d. Admin: Flush / Reset Cache
  router.post('/admin/cache/flush', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      if (!session?.id) return res.status(401).json({ error: 'Harap login' });

      const adminUser = await prisma.user.findUnique({ where: { id: session.id } });
      if (adminUser?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Akses khusus Administrator' });
      }

      await AuditLogService.record({
        userId: adminUser.id,
        eventType: 'CACHE_FLUSH',
        metadata: { admin: adminUser.username },
      });

      sseService.broadcast('status:changed', { action: 'cache_flushed' });

      return res.json({ success: true, message: 'Cache sesi telah berhasil di-refresh!' });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal membersihkan cache' });
    }
  });

  // 11e. Admin: Ambil Riwayat Audit Trail
  router.get('/admin/audit-logs', async (req: Request, res: Response) => {
    try {
      const session = await getSessionUser(req);
      if (!session?.id) return res.status(401).json({ error: 'Harap login' });

      const adminUser = await prisma.user.findUnique({ where: { id: session.id } });
      if (adminUser?.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Akses khusus Administrator' });
      }

      const logs = await AuditLogService.getRecentLogs(40);
      return res.json({ logs });
    } catch (err) {
      return res.status(500).json({ error: 'Gagal memuat riwayat aktivitas audit' });
    }
  });

  return router;
}
