import { prisma } from '../../database/prisma';
import { ExtractedTask } from '../ai/ai.service';
import { Task } from '@prisma/client';
import { reminderQueue } from '../../workers/queue';
import { subMinutes } from 'date-fns';
import { logger } from '../../shared/utils/logger';

export class TaskService {
  static async getOrCreateUser(discordId: string, username: string) {
    return prisma.user.upsert({
      where: { discordId },
      update: { username },
      create: { discordId, username, timezone: 'Asia/Jakarta' }
    });
  }

  static async getOrCreateGuild(discordGuildId: string, name?: string) {
    return prisma.guild.upsert({
      where: { discordGuildId },
      update: name ? { name } : {},
      create: { discordGuildId, name: name || 'Discord Server' }
    });
  }

  static async createTaskFromAI(
    discordId: string, 
    username: string, 
    extracted: ExtractedTask,
    metadata?: {
      guildId?: string;
      guildName?: string;
      sourceType?: string;
      sourceMessageId?: string;
      sourceChannelId?: string;
      taskType?: 'INDIVIDUAL' | 'GROUP';
      assignedUserIds?: string[];
    }
  ): Promise<Task> {
    const user = await this.getOrCreateUser(discordId, username);

    let dbGuildId: string | null = null;
    if (metadata?.guildId) {
      const guild = await this.getOrCreateGuild(metadata.guildId, metadata.guildName);
      dbGuildId = guild.id;
    }

    const dueAtDate = extracted.dueAt ? new Date(extracted.dueAt) : null;
    const taskType = metadata?.taskType || 'INDIVIDUAL';
    const assignedUserIds = metadata?.assignedUserIds || [discordId];

    // 1. Simpan Task ke Database
    const task = await prisma.task.create({
      data: {
        userId: user.id,
        guildId: dbGuildId,
        courseId: extracted.courseName || null,
        title: extracted.title,
        description: extracted.description || null,
        linkUrl: extracted.linkUrl,
        dueAt: dueAtDate,
        estimatedMinutes: extracted.estimatedMinutes,
        priority: extracted.priority || 'MEDIUM',
        status: 'TODO',
        sourceType: metadata?.sourceType,
        sourceMessageId: metadata?.sourceMessageId,
        sourceChannelId: metadata?.sourceChannelId,
        taskType,
        assignedUserIds
      }
    });

    // 1b. Jika AI mendeteksi sub-tugas/format checklist, otomatis buatkan di database
    if (extracted.subtasks && extracted.subtasks.length > 0) {
      await this.createSubtasks(task.id, extracted.subtasks);
      logger.info(`Otomatis membuat ${extracted.subtasks.length} subtask checklist untuk task ${task.id}`);
    }

    // 2. Jika ada deadline, daftarkan 3 Tahap Reminder Bertingkat (H-24H, H-3H, H-30M) ke BullMQ (Redis)
    if (dueAtDate) {
      await this.scheduleTaskReminders(task);
    }

    // Catat ke Activity Log
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        taskId: task.id,
        eventType: 'TASK_CREATED',
        metadata: { title: task.title, dueAt: task.dueAt, priority: task.priority, taskType }
      }
    });

    return task;
  }

  /**
   * ⏰ Menjadwalkan 3 Tahap Pengingat Bertingkat:
   * 1. Stage H-24H (1 Hari Sebelum): Peringatan persiapan awal
   * 2. Stage H-3H  (3 Jam Sebelum): Peringatan hitung mundur
   * 3. Stage H-30M (30 Menit Sebelum): Panggilan terakhir / Final Call
   */
  static async scheduleTaskReminders(task: Task) {
    if (!task.dueAt) return;
    const nowMs = Date.now();
    const dueMs = task.dueAt.getTime();
    const totalMinutesLeft = (dueMs - nowMs) / (1000 * 60);

    const STAGES = [
      {
        id: 'H24',
        minutesBefore: 24 * 60,
        title: '⏰ Pengingat H-24 Jam (Besok Deadline!)',
        desc: 'Tugas ini harus dikumpulkan besok! Sudah mulai mencicil pekerjaanmu?',
        color: '#F1C40F' // Kuning
      },
      {
        id: 'H3',
        minutesBefore: 3 * 60,
        title: '⚠️ Pengingat H-3 Jam (Hitung Mundur)',
        desc: 'Waktu tersisa 3 jam lagi! Segera tuntaskan bagian penting dari tugas ini.',
        color: '#E67E22' // Oranye
      },
      {
        id: 'H30M',
        minutesBefore: 30,
        title: '🚨 Panggilan Terakhir (H-30 Menit)',
        desc: 'Deadline tinggal 30 menit! Pastikan file tugas sudah siap dan di-submit ke tempat pengumpulan.',
        color: '#E74C3C' // Merah
      }
    ];

    let scheduledCount = 0;
    for (const stage of STAGES) {
      const triggerTimeMs = dueMs - (stage.minutesBefore * 60 * 1000);
      const delay = triggerTimeMs - nowMs;

      // Hanya jadwalkan jika waktu pemicu masih di masa depan
      if (delay > 0) {
        await reminderQueue.add('send-reminder', {
          taskId: task.id,
          stageId: stage.id,
          stageTitle: stage.title,
          stageDesc: stage.desc,
          color: stage.color,
          channelId: task.sourceChannelId,
          taskType: task.taskType
        }, {
          delay,
          jobId: `reminder_${task.id}_${stage.id}`
        });
        scheduledCount++;
      }
    }

    // Fallback: Jika waktu tersisa kurang dari 30 menit tapi masih di masa depan (> 1 menit)
    if (scheduledCount === 0 && totalMinutesLeft > 1) {
      const urgentDelay = Math.max(1000, (totalMinutesLeft - 2) * 60 * 1000);
      await reminderQueue.add('send-reminder', {
        taskId: task.id,
        stageId: 'URGENT',
        stageTitle: '🚨 Peringatan Mendesak Deadline!',
        stageDesc: `Batas waktu pengumpulan tinggal ${Math.round(totalMinutesLeft)} menit lagi! Segera tuntaskan & kumpulkan tugasmu!`,
        color: '#E74C3C',
        channelId: task.sourceChannelId,
        taskType: task.taskType
      }, {
        delay: urgentDelay,
        jobId: `reminder_${task.id}_urgent`
      });
      scheduledCount++;
    }

    logger.info(`Berhasil menjadwalkan ${scheduledCount} tahap reminder untuk task ${task.id} (${task.taskType})`);
  }

  /**
   * Membatalkan seluruh reminder terjadwal untuk task tertentu
   */
  static async cancelTaskReminders(taskId: string) {
    const stageIds = ['H24', 'H3', 'H30M', 'urgent'];
    for (const s of stageIds) {
      try {
        const job = await reminderQueue.getJob(`reminder_${taskId}_${s}`);
        if (job) await job.remove();
      } catch {}
    }
  }

  static async markTaskDone(taskId: string): Promise<Task | null> {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task) return null;

    const updatedTask = await prisma.task.update({
      where: { id: taskId },
      data: {
        status: 'DONE',
        completedAt: new Date()
      }
    });

    // Batalkan seluruh jadwal reminder yang masih tertunda di BullMQ
    await this.cancelTaskReminders(taskId);

    // Catat ke Activity Log
    await prisma.activityLog.create({
      data: {
        userId: task.userId,
        taskId: task.id,
        eventType: 'TASK_COMPLETED',
        metadata: { title: task.title }
      }
    });

    // Beri XP (+50 XP) untuk produktivitas!
    await this.addXP(task.userId, 50);

    return updatedTask;
  }

  static async snoozeTask(taskId: string, minutes: number = 30): Promise<Date | null> {
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status === 'DONE' || task.status === 'CANCELLED') return null;

    const delay = minutes * 60 * 1000;
    const snoozeJobId = `reminder_${task.id}_snooze_${Date.now()}`;

    // Batalkan pengingat sebelumnya & jadwalkan pengingat tunda
    await this.cancelTaskReminders(taskId);

    await reminderQueue.add('send-reminder', {
      taskId: task.id,
      stageId: 'SNOOZE',
      stageTitle: '⏰ Pengingat Tugas (Setelah Ditunda)',
      stageDesc: `Pengingat tugas ini sebelumnya ditunda selama ${minutes} menit. Waktunya kembali produktif!`,
      color: '#F1C40F',
      channelId: task.sourceChannelId,
      taskType: task.taskType
    }, {
      delay,
      jobId: snoozeJobId
    });

    const reminderTime = new Date(Date.now() + delay);

    await prisma.reminder.create({
      data: {
        taskId: task.id,
        userId: task.userId,
        reminderAt: reminderTime,
        status: 'PENDING',
        deliveryType: task.sourceChannelId ? 'THREAD_AND_DM' : 'DM',
        deliveryChannelId: task.sourceChannelId || null
      }
    });

    await prisma.activityLog.create({
      data: {
        userId: task.userId,
        taskId: task.id,
        eventType: 'TASK_SNOOZED',
        metadata: { minutes, nextReminder: reminderTime }
      }
    });

    logger.info(`Task ${taskId} di-snooze selama ${minutes} menit`);
    return reminderTime;
  }

  static async startFocusSession(taskId: string, discordId: string, durationMinutes: number = 25, guildId?: string) {
    const user = await this.getOrCreateUser(discordId, 'User');

    const session = await prisma.focusSession.create({
      data: {
        taskId: taskId && taskId.length > 0 ? taskId : null,
        userId: user.id,
        startedAt: new Date(),
        durationMinutes
      }
    });

    // Jadwalkan notifikasi saat sesi fokus selesai
    const delay = durationMinutes * 60 * 1000;
    await reminderQueue.add('focus-end', {
      sessionId: session.id,
      userId: user.id,
      discordId,
      taskId: session.taskId,
      durationMinutes,
      guildId
    }, {
      delay,
      jobId: `focus_${session.id}`
    });

    await prisma.activityLog.create({
      data: {
        userId: user.id,
        taskId: session.taskId,
        eventType: 'FOCUS_STARTED',
        metadata: { durationMinutes, guildId }
      }
    });

    // Beri XP (+25 atau +50) atas komitmen fokus
    const xpPoints = durationMinutes >= 50 ? 50 : 25;
    await this.addXP(user.id, xpPoints);

    return session;
  }

  static async createSubtasks(taskId: string, titles: string[]) {
    const data = titles.map((title, index) => ({
      taskId,
      title,
      position: index,
      status: 'TODO' as const
    }));
    await prisma.subtask.createMany({ data });
    return this.getSubtasks(taskId);
  }

  static async getSubtasks(taskId: string) {
    return prisma.subtask.findMany({
      where: { taskId },
      orderBy: { position: 'asc' }
    });
  }

  static async toggleSubtask(subtaskId: string) {
    const sub = await prisma.subtask.findUnique({ where: { id: subtaskId } });
    if (!sub) return null;
    const newStatus = sub.status === 'DONE' ? 'TODO' : 'DONE';
    return prisma.subtask.update({
      where: { id: subtaskId },
      data: {
        status: newStatus,
        completedAt: newStatus === 'DONE' ? new Date() : null
      }
    });
  }

  static async addXP(userId: string, points: number) {
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) return null;

    const now = new Date();
    let newStreak = user.streak || 0;

    if (user.lastActiveAt) {
      const diffHours = (now.getTime() - user.lastActiveAt.getTime()) / (1000 * 60 * 60);
      if (diffHours >= 20 && diffHours <= 48) {
        newStreak += 1;
      } else if (diffHours > 48) {
        newStreak = 1;
      }
    } else {
      newStreak = 1;
    }

    return prisma.user.update({
      where: { id: userId },
      data: {
        xp: { increment: points },
        streak: newStreak,
        lastActiveAt: now
      }
    });
  }

  static async getUserStats(discordId: string) {
    const user = await prisma.user.findUnique({
      where: { discordId },
      include: {
        tasks: true,
        focusSessions: true
      }
    });
    if (!user) return null;

    const completedTasks = user.tasks.filter(t => t.status === 'DONE').length;
    const totalTasks = user.tasks.length;
    const totalFocusMinutes = user.focusSessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);
    const level = Math.floor(user.xp / 100) + 1;

    return {
      username: user.username,
      xp: user.xp,
      level,
      streak: user.streak,
      completedTasks,
      totalTasks,
      totalFocusMinutes
    };
  }

  static async getLeaderboard(limit: number = 10) {
    return prisma.user.findMany({
      orderBy: { xp: 'desc' },
      take: limit,
      select: {
        discordId: true,
        username: true,
        xp: true,
        streak: true
      }
    });
  }

  static async getUserActiveTasks(discordId: string, limit: number = 10) {
    return prisma.task.findMany({
      where: {
        OR: [
          { user: { discordId } },
          { assignedUserIds: { has: discordId } }
        ],
        status: { in: ['TODO', 'IN_PROGRESS'] },
        deletedAt: null
      },
      orderBy: [
        { dueAt: 'asc' },
        { priority: 'desc' }
      ],
      take: limit
    });
  }

  /**
   * ⚠️ Phase 5: Analisis Beban Kerja Harian (Workload Detection)
   */
  static async getWorkloadStats(discordId: string, guildId?: string) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const endOfTomorrow = new Date(startOfToday.getTime() + 48 * 60 * 60 * 1000);
    endOfTomorrow.setHours(23, 59, 59, 999);

    const tasks = await prisma.task.findMany({
      where: {
        OR: [
          { user: { discordId } },
          { assignedUserIds: { has: discordId } }
        ],
        status: { in: ['TODO', 'IN_PROGRESS'] },
        deletedAt: null,
        dueAt: { lte: endOfTomorrow }
      },
      orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }]
    });

    const totalMinutes = tasks.reduce((acc, t) => acc + (t.estimatedMinutes || 60), 0);
    const availableMinutes = 300; // Standar 5 jam waktu produktif per hari

    let status: 'LIGHT' | 'MODERATE' | 'HEAVY' | 'OVERLOAD' = 'LIGHT';
    if (totalMinutes > 360) {
      status = 'OVERLOAD';
    } else if (totalMinutes > 240) {
      status = 'HEAVY';
    } else if (totalMinutes > 120) {
      status = 'MODERATE';
    }

    return {
      tasks,
      totalMinutes,
      availableMinutes,
      status
    };
  }

  /**
   * 📊 Phase 5: Weekly Productivity Review Data
   */
  static async getWeeklyReviewStats(discordId: string) {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const now = new Date();

    const user = await prisma.user.findUnique({
      where: { discordId },
      include: {
        focusSessions: {
          where: { startedAt: { gte: sevenDaysAgo } }
        }
      }
    });

    if (!user) return null;

    const completedTasks = await prisma.task.findMany({
      where: {
        OR: [
          { user: { discordId } },
          { assignedUserIds: { has: discordId } }
        ],
        status: 'DONE',
        completedAt: { gte: sevenDaysAgo }
      },
      orderBy: { completedAt: 'desc' }
    });

    const overdueTasks = await prisma.task.findMany({
      where: {
        OR: [
          { user: { discordId } },
          { assignedUserIds: { has: discordId } }
        ],
        status: { in: ['TODO', 'IN_PROGRESS'] },
        deletedAt: null,
        dueAt: { lt: now }
      },
      orderBy: { dueAt: 'asc' }
    });

    const totalFocusMinutes = user.focusSessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);

    // Hitung akurasi estimasi jika ada task yang memiliki actualMinutes dan estimatedMinutes
    let estimatedSum = 0;
    let actualSum = 0;
    for (const t of completedTasks) {
      if (t.estimatedMinutes) {
        estimatedSum += t.estimatedMinutes;
        actualSum += t.actualMinutes || t.estimatedMinutes;
      }
    }
    const accuracyScore = estimatedSum > 0 
      ? Math.min(100, Math.round((Math.min(estimatedSum, actualSum) / Math.max(estimatedSum, actualSum)) * 100))
      : 85; // Default score baseline

    return {
      user,
      completedTasks,
      overdueTasks,
      totalFocusMinutes,
      accuracyScore
    };
  }

  /**
   * 📚 Phase 6: Mode Mata Kuliah (Course Mode)
   * Mengambil daftar seluruh mata kuliah di server beserta statistik tugasnya
   */
  static async getCoursesWithTasks(discordGuildId: string) {
    const guild = await prisma.guild.findUnique({
      where: { discordGuildId }
    });
    if (!guild) return [];

    const tasks = await prisma.task.findMany({
      where: {
        guildId: guild.id,
        courseId: { not: null },
        deletedAt: null
      }
    });

    const courseMap = new Map<string, { name: string; total: number; active: number; done: number }>();

    for (const t of tasks) {
      const cName = t.courseId!;
      if (!courseMap.has(cName)) {
        courseMap.set(cName, { name: cName, total: 0, active: 0, done: 0 });
      }
      const entry = courseMap.get(cName)!;
      entry.total += 1;
      if (t.status === 'DONE') {
        entry.done += 1;
      } else {
        entry.active += 1;
      }
    }

    return Array.from(courseMap.values());
  }

  /**
   * 📚 Ambil daftar tugas aktif berdasarkan nama mata kuliah
   */
  static async getTasksByCourse(discordGuildId: string, courseName: string) {
    const guild = await prisma.guild.findUnique({
      where: { discordGuildId }
    });
    if (!guild) return [];

    return prisma.task.findMany({
      where: {
        guildId: guild.id,
        courseId: { equals: courseName, mode: 'insensitive' },
        deletedAt: null
      },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }]
    });
  }
}

