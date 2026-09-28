import { prisma } from '../../database/prisma';
import { ExtractedTask } from '../ai/ai.service';
import { Task } from '@prisma/client';
import { reminderQueue } from '../../workers/queue';
import { subMinutes } from 'date-fns';
import { logger } from '../../shared/utils/logger';
import { Client, TextChannel, EmbedBuilder, ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import { generateGoogleCalendarUrl } from '../../shared/utils/calendar';
import { GuildService } from '../guild/guild.service';

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
    await prisma.reminder.updateMany({
      where: { taskId, status: 'PENDING' },
      data: { status: 'CANCELLED' }
    }).catch(() => null);
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

  static async snoozeTask(
    taskId: string,
    minutes: number = 30
  ): Promise<{ nextReminder: Date; snoozeCount: number } | null> {
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

    // Increment snooze count pada database
    const updated = await prisma.task.update({
      where: { id: taskId },
      data: { snoozeCount: { increment: 1 } }
    });

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
        metadata: { minutes, nextReminder: reminderTime, snoozeCount: updated.snoozeCount }
      }
    });

    logger.info(`Task ${taskId} di-snooze selama ${minutes} menit (Total snooze: ${updated.snoozeCount})`);
    return { nextReminder: reminderTime, snoozeCount: updated.snoozeCount };
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

  /**
   * 💬 Ambil seluruh tugas user (dan guild) beserta subtasks untuk konteks AI Query
   */
  static async getTasksForAIQuery(discordId: string, discordGuildId?: string) {
    const user = await prisma.user.findUnique({
      where: { discordId },
      include: { focusSessions: true }
    });

    const orConditions: any[] = [
      { user: { discordId } },
      { assignedUserIds: { has: discordId } }
    ];

    if (discordGuildId) {
      const guild = await prisma.guild.findUnique({ where: { discordGuildId } });
      if (guild) {
        orConditions.push({ guildId: guild.id });
      }
    }

    const tasks = await prisma.task.findMany({
      where: {
        OR: orConditions,
        deletedAt: null
      },
      include: {
        subtasks: true
      },
      orderBy: [{ status: 'asc' }, { dueAt: 'asc' }],
      take: 25
    });

    let userStats = null;
    if (user) {
      const totalFocusMinutes = user.focusSessions.reduce((acc, s) => acc + (s.durationMinutes || 0), 0);
      userStats = {
        username: user.username,
        xp: user.xp,
        level: Math.floor(user.xp / 100) + 1,
        streak: user.streak,
        totalFocusMinutes
      };
    }

    return { tasks, userStats };
  }

  // ══════════════════════════════════════════════════════════════
  // 🔁 RECURRING TASKS (Phase 10)
  // ══════════════════════════════════════════════════════════════

  /**
   * Hitung nextRunAt berdasarkan repeat pattern, dayOfWeek, dan jam deadline (UTC)
   */
  static computeNextRun(pattern: string, dayOfWeek: number | null, hourUTC: number, minuteUTC: number, afterDate?: Date): Date {
    const now = afterDate || new Date();
    const next = new Date(now);
    next.setUTCSeconds(0, 0);
    next.setUTCHours(hourUTC, minuteUTC);

    if (pattern === 'DAILY') {
      // Jika waktu hari ini sudah lewat, set ke besok
      if (next <= now) {
        next.setUTCDate(next.getUTCDate() + 1);
      }
      return next;
    }

    // WEEKLY atau BIWEEKLY
    const targetDay = dayOfWeek ?? 5; // Default Jumat
    const currentDay = next.getUTCDay();
    let daysUntil = targetDay - currentDay;
    if (daysUntil < 0) daysUntil += 7;
    if (daysUntil === 0 && next <= now) daysUntil = 7;
    if (pattern === 'BIWEEKLY' && daysUntil <= 7) {
      // Untuk biweekly, pastikan minimal 7 hari ke depan jika sudah di minggu yang sama
      if (daysUntil < 7) daysUntil += 7;
    }
    next.setUTCDate(next.getUTCDate() + daysUntil);
    return next;
  }

  /**
   * Buat recurring task baru
   */
  static async createRecurringTask(data: {
    discordId: string;
    username: string;
    guildId?: string;
    guildName?: string;
    title: string;
    description?: string | null;
    courseName?: string | null;
    linkUrl?: string | null;
    priority?: string;
    taskType?: string;
    assignedUserIds?: string[];
    subtasks?: string[];
    repeatPattern: string;
    dayOfWeek: number | null;
    deadlineHour: number;  // Jam lokal user
    deadlineMinute: number; // Menit lokal user
  }) {
    const user = await this.getOrCreateUser(data.discordId, data.username);
    let dbGuildId: string | null = null;
    if (data.guildId) {
      const guild = await this.getOrCreateGuild(data.guildId, data.guildName);
      dbGuildId = guild.id;
    }

    // Convert jam lokal (WIB = UTC+7) ke UTC
    const hourUTC = (data.deadlineHour - 7 + 24) % 24;
    const minuteUTC = data.deadlineMinute;

    // 1. Hitung deadline untuk siklus aktif pertama yang akan segera datang
    const firstDueAt = this.computeNextRun(data.repeatPattern, data.dayOfWeek, hourUTC, minuteUTC);

    // 2. Jadwal generasi berikutnya (setelah siklus pertama selesai)
    const nextRunAt = this.computeNextRun(data.repeatPattern, data.dayOfWeek, hourUTC, minuteUTC, firstDueAt);

    const recurring = await prisma.recurringTask.create({
      data: {
        userId: user.id,
        guildId: dbGuildId,
        title: data.title,
        description: data.description || null,
        courseName: data.courseName || null,
        linkUrl: data.linkUrl || null,
        priority: data.priority || 'MEDIUM',
        taskType: data.taskType || 'INDIVIDUAL',
        assignedUserIds: data.assignedUserIds || [data.discordId],
        subtasks: data.subtasks && data.subtasks.length > 0 ? data.subtasks : undefined,
        repeatPattern: data.repeatPattern,
        dayOfWeek: data.dayOfWeek,
        hourUTC,
        minuteUTC,
        nextRunAt,
        lastCreatedAt: new Date(),
        isActive: true
      }
    });

    // 3. Langsung buat task instance untuk siklus pertama agar thread dan checklist segera aktif!
    const subtasksArray = Array.isArray(data.subtasks) ? data.subtasks : [];
    const initialTask = await prisma.task.create({
      data: {
        userId: user.id,
        guildId: dbGuildId,
        courseId: data.courseName || null,
        title: data.title,
        description: data.description || null,
        linkUrl: data.linkUrl || null,
        dueAt: firstDueAt,
        priority: (data.priority as any) || 'MEDIUM',
        status: 'TODO',
        taskType: data.taskType || 'INDIVIDUAL',
        assignedUserIds: data.assignedUserIds || [data.discordId],
        recurringRule: `${data.repeatPattern}:${recurring.id}`,
        sourceType: 'RECURRING'
      }
    });

    if (subtasksArray.length > 0) {
      await this.createSubtasks(initialTask.id, subtasksArray);
    }

    if (firstDueAt) {
      await this.scheduleTaskReminders(initialTask);
    }

    logger.info(`RecurringTask dibuat: "${recurring.title}" (${recurring.repeatPattern}) initialTaskId=${initialTask.id}`);
    return { recurring, initialTask, firstDueAt };
  }

  /**
   * Ambil daftar recurring tasks user
   */
  static async getUserRecurringTasks(discordId: string, guildDiscordId?: string) {
    const user = await prisma.user.findUnique({ where: { discordId } });
    if (!user) return [];

    const where: any = { userId: user.id, isActive: true };
    if (guildDiscordId) {
      const guild = await prisma.guild.findUnique({ where: { discordGuildId: guildDiscordId } });
      if (guild) where.guildId = guild.id;
    }

    return prisma.recurringTask.findMany({
      where,
      orderBy: { nextRunAt: 'asc' }
    });
  }

  /**
   * Nonaktifkan / hapus recurring task
   */
  static async deleteRecurringTask(recurringId: string, discordId: string) {
    const user = await prisma.user.findUnique({ where: { discordId } });
    if (!user) return null;

    const recurring = await prisma.recurringTask.findFirst({
      where: { id: recurringId, userId: user.id }
    });
    if (!recurring) return null;

    return prisma.recurringTask.update({
      where: { id: recurringId },
      data: { isActive: false }
    });
  }

  /**
   * 🔁 Process Recurring Tasks — Dipanggil oleh scheduler interval
   * Cek semua recurring yang nextRunAt sudah lewat, buat task baru, lalu update nextRunAt
   */
  static async processRecurringTasks(): Promise<{ createdTasks: any[]; errors: string[] }> {
    const now = new Date();
    const dueRecurrings = await prisma.recurringTask.findMany({
      where: {
        isActive: true,
        nextRunAt: { lte: now }
      },
      include: { user: true, guild: true }
    });

    const createdTasks: any[] = [];
    const errors: string[] = [];

    for (const rec of dueRecurrings) {
      try {
        // Hitung deadline: nextRunAt + offset hari dari pattern
        const dueAt = new Date(rec.nextRunAt);

        // Buat task baru
        const subtasksArray = Array.isArray(rec.subtasks) ? rec.subtasks as string[] : [];
        const task = await prisma.task.create({
          data: {
            userId: rec.userId,
            guildId: rec.guildId,
            courseId: rec.courseName || null,
            title: rec.title,
            description: rec.description,
            linkUrl: rec.linkUrl,
            dueAt,
            priority: rec.priority as any || 'MEDIUM',
            status: 'TODO',
            taskType: rec.taskType,
            assignedUserIds: rec.assignedUserIds,
            recurringRule: `${rec.repeatPattern}:${rec.id}`,
            sourceType: 'RECURRING'
          }
        });

        // Buat subtask jika ada template
        if (subtasksArray.length > 0) {
          await this.createSubtasks(task.id, subtasksArray);
        }

        // Jadwalkan reminders untuk task yang baru dibuat
        if (dueAt) {
          await this.scheduleTaskReminders(task);
        }

        // Update nextRunAt ke jadwal berikutnya
        const nextRun = this.computeNextRun(rec.repeatPattern, rec.dayOfWeek, rec.hourUTC, rec.minuteUTC, now);
        await prisma.recurringTask.update({
          where: { id: rec.id },
          data: { nextRunAt: nextRun, lastCreatedAt: now }
        });

        createdTasks.push({
          taskId: task.id,
          task,
          title: task.title,
          discordId: rec.user.discordId,
          guildDiscordId: rec.guild?.discordGuildId,
          courseName: rec.courseName,
          taskType: rec.taskType,
          linkUrl: rec.linkUrl,
          dueAt: task.dueAt,
          assignedUserIds: rec.assignedUserIds,
          subtasks: subtasksArray,
          description: rec.description,
          priority: rec.priority
        });
        logger.info(`Recurring auto-created task: "${task.title}" (next: ${nextRun.toISOString()})`);
      } catch (err: any) {
        const errMsg = `Gagal proses recurring ${rec.id}: ${err?.message || err}`;
        errors.push(errMsg);
        logger.error({ err }, errMsg);
      }
    }

    return { createdTasks, errors };
  }

  /**
   * Mengirim tugas ke Discord: membuat/menggunakan thread di #inbox-tugas server terpilih,
   * mengirimkan kartu tugas interaktif, dan memperbarui Live Deadline Radar.
   */
  static async dispatchTaskToDiscord(
    taskId: string,
    client: Client,
    targetDiscordGuildId?: string
  ): Promise<boolean> {
    try {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: { user: true, guild: true, subtasks: { orderBy: { position: 'asc' } } }
      });
      if (!task) return false;

      // Cari guild tujuan
      if (!targetDiscordGuildId && !task.guild?.discordGuildId) {
        logger.info(`Tugas ${taskId} dibuat sebagai tugas pribadi (tanpa thread server)`);
        return false;
      }

      if (targetDiscordGuildId === 'PERSONAL' || targetDiscordGuildId === 'none') {
        logger.info(`Tugas ${taskId} ditandai sebagai tugas pribadi (tanpa thread server)`);
        return false;
      }

      let dbGuild = null;
      if (targetDiscordGuildId) {
        dbGuild = await prisma.guild.findFirst({
          where: {
            OR: [
              { discordGuildId: targetDiscordGuildId },
              { id: targetDiscordGuildId }
            ]
          }
        });
      } else if (task.guild?.discordGuildId) {
        dbGuild = await prisma.guild.findUnique({ where: { discordGuildId: task.guild.discordGuildId } });
      }

      if (!dbGuild || !dbGuild.inboxChannelId) {
        logger.info(`Tugas ${taskId}: Guild tidak memiliki inboxChannelId terkonfigurasi`);
        return false;
      }

      const discordGuild = client.guilds.cache.get(dbGuild.discordGuildId);
      if (!discordGuild) {
        logger.warn(`Guild ${dbGuild.discordGuildId} tidak ditemukan di cache bot`);
        return false;
      }

      const inboxChannel = discordGuild.channels.cache.get(dbGuild.inboxChannelId) as TextChannel | undefined;
      if (!inboxChannel || !('threads' in inboxChannel)) {
        logger.warn(`Inbox channel ${dbGuild.inboxChannelId} tidak valid di guild ${discordGuild.name}`);
        return false;
      }

      const isGroup = task.taskType === 'GROUP';
      const threadPrefix = isGroup ? '👥・[Kelompok]' : '📚・[Individu]';
      const courseOrTitle = task.courseId || task.title;
      const threadName = `${threadPrefix} ${courseOrTitle.slice(0, 75)}`;

      let thread = null;
      try {
        const activeThreads = await inboxChannel.threads.fetchActive().catch(() => null);
        if (activeThreads) {
          thread = activeThreads.threads.find(
            t => !t.archived && t.name.toLowerCase().includes(courseOrTitle.toLowerCase())
          );
        }
      } catch (err) {
        logger.warn({ err }, 'Gagal fetch active threads');
      }

      if (!thread) {
        try {
          thread = await inboxChannel.threads.create({
            name: threadName,
            autoArchiveDuration: 1440,
            reason: 'TaskFlow OS Task Created via Web Dashboard'
          });
        } catch (threadErr) {
          logger.warn({ threadErr }, 'Gagal membuat thread di Discord');
        }
      }

      const targetSendChannel = thread || inboxChannel;

      // Tambahkan anggota ke thread
      if (thread) {
        const memberIds = task.assignedUserIds && task.assignedUserIds.length > 0
          ? task.assignedUserIds
          : [task.user.discordId];
        for (const uid of memberIds) {
          if (/^\d{16,20}$/.test(uid)) {
            await thread.members.add(uid).catch(() => null);
          }
        }
      }

      // Siapkan deadline text
      const deadlineText = task.dueAt
        ? `<t:${Math.floor(task.dueAt.getTime() / 1000)}:F> (<t:${Math.floor(task.dueAt.getTime() / 1000)}:R>)`
        : 'Tidak ada batas waktu';

      // Siapkan tombol aksi
      const primaryButtons = [
        new ButtonBuilder()
          .setCustomId(`task_done_${task.id}`)
          .setLabel('Selesai')
          .setStyle(ButtonStyle.Success)
          .setEmoji('✅'),
        new ButtonBuilder()
          .setCustomId(`task_edit_${task.id}`)
          .setLabel('Edit')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('✏️'),
        new ButtonBuilder()
          .setCustomId(`task_breakdown_${task.id}`)
          .setLabel('AI Breakdown')
          .setStyle(ButtonStyle.Primary)
          .setEmoji('🧩'),
        new ButtonBuilder()
          .setCustomId(`task_snooze_${task.id}_30`)
          .setLabel('Tunda 30m')
          .setStyle(ButtonStyle.Secondary)
          .setEmoji('💤')
      ];

      const linkButtons = [];
      if (task.dueAt) {
        const gcalUrl = generateGoogleCalendarUrl(task.title, task.dueAt, task.linkUrl, task.description);
        linkButtons.push(
          new ButtonBuilder()
            .setLabel('Google Calendar')
            .setStyle(ButtonStyle.Link)
            .setURL(gcalUrl)
            .setEmoji('📅')
        );
      }

      if (task.linkUrl) {
        linkButtons.push(
          new ButtonBuilder()
            .setLabel('Buka Link')
            .setStyle(ButtonStyle.Link)
            .setURL(task.linkUrl)
            .setEmoji('🔗')
        );
      }

      const actionRows: ActionRowBuilder<ButtonBuilder>[] = [
        new ActionRowBuilder<ButtonBuilder>().addComponents(primaryButtons)
      ];
      if (linkButtons.length > 0) {
        actionRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(linkButtons));
      }

      const embedColor = isGroup ? '#9B59B6' : '#00E5FF';
      const embedTitle = isGroup
        ? '👥 Task Kelompok (Dibuat via Web Dashboard)'
        : '👤 Task Individu (Dibuat via Web Dashboard)';

      const memberListText = task.assignedUserIds && task.assignedUserIds.length > 0
        ? task.assignedUserIds.map(id => (/^\d{16,20}$/.test(id) ? `<@${id}>` : id)).join(', ')
        : `<@${task.user.discordId}>`;

      let subtaskText = '';
      if (task.subtasks && task.subtasks.length > 0) {
        subtaskText = '\n\n**Subtasks / Checklist:**\n' +
          task.subtasks.map(s => `• ⬜ ${s.title}`).join('\n');
      }

      const embed = new EmbedBuilder()
        .setTitle(embedTitle)
        .setDescription(
          `### **${task.title}**\n\n` +
          `🏷️ **Tipe:** **${isGroup ? '👥 Tugas Kelompok' : '👤 Tugas Individu'}**\n` +
          (task.courseId ? `📚 **Mata Kuliah:** ${task.courseId}\n` : '') +
          `👥 **Anggota:** ${memberListText}\n` +
          `⏰ **Deadline:** ${deadlineText}\n` +
          `🔥 **Prioritas:** ${task.priority}` +
          (task.description ? `\n\n📝 **Catatan:** ${task.description}` : '') +
          subtaskText
        )
        .setColor(embedColor)
        .setFooter({ text: `TaskFlow OS Web Sync • ID: ${task.id.slice(-6)}` });

      const cardMsg = await targetSendChannel.send({
        embeds: [embed],
        components: actionRows
      });

      // Update task dengan ID channel thread & ID message
      await prisma.task.update({
        where: { id: task.id },
        data: {
          guildId: dbGuild.id,
          sourceChannelId: targetSendChannel.id,
          sourceMessageId: cardMsg.id,
        }
      });

      // Update Live Radar Dashboard di channel radar guild
      await GuildService.updateRadarDashboard(discordGuild);
      logger.info(`Tugas "${task.title}" berhasil diposting ke thread Discord: ${targetSendChannel.name} di guild ${discordGuild.name}`);
      return true;
    } catch (err) {
      logger.error({ err, taskId }, 'Gagal dispatch task ke Discord');
      return false;
    }
  }

  /**
   * 🔄 Sinkronisasi Status Tugas dari Web Dashboard ke Discord
   * Mengupdate card embed, mengirim pengumuman di thread, memperbarui Live Radar,
   * dan mengarsipkan thread jika seluruh tugas di thread telah selesai.
   */
  static async syncTaskStatusToDiscord(
    taskId: string,
    client: Client,
    newStatus: string,
    actorUsername?: string
  ): Promise<boolean> {
    try {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          user: true,
          guild: true,
          subtasks: { orderBy: { position: 'asc' } }
        }
      });
      if (!task || !task.guild?.discordGuildId) return false;

      const discordGuild = client.guilds.cache.get(task.guild.discordGuildId) ||
        await client.guilds.fetch(task.guild.discordGuildId).catch(() => null);

      // 1. Update Live Radar di channel deadline-radar
      if (discordGuild) {
        await GuildService.updateRadarDashboard(discordGuild, client);
      }

      // 2. Jika ada sourceChannelId, update card embed & kirim notifikasi ke thread
      if (task.sourceChannelId) {
        const channel = await client.channels.fetch(task.sourceChannelId).catch(() => null);
        if (channel && 'send' in channel) {
          const actor = actorUsername || task.user.username || 'Mahasiswa';

          if (newStatus === 'DONE') {
            await this.cancelTaskReminders(task.id);

            // Update embed pesan kartu jika ada
            if (task.sourceMessageId && 'messages' in channel) {
              try {
                const cardMsg = await (channel as any).messages.fetch(task.sourceMessageId).catch(() => null);
                if (cardMsg && cardMsg.editable) {
                  const subtaskText = task.subtasks.length > 0
                    ? '\n\n**Subtasks / Checklist:**\n' +
                      task.subtasks.map(s => `• ✅ ~~${s.title}~~`).join('\n')
                    : '';

                  const doneEmbed = new EmbedBuilder()
                    .setTitle(`✅ [SELESAI] ~~${task.title}~~`)
                    .setDescription(
                      `🎉 **Tugas Telah Selesai!**\n\n` +
                      `👤 **Ditandai selesai oleh:** **${actor}** *(via Web Dashboard)*\n` +
                      `⏰ **Waktu Selesai:** <t:${Math.floor(Date.now() / 1000)}:F>\n` +
                      (task.courseId ? `📚 **Mata Kuliah:** ${task.courseId}\n` : '') +
                      subtaskText
                    )
                    .setColor('#00FF7F')
                    .setFooter({ text: `TaskFlow OS • ID: ${task.id.slice(-6)} • Selesai via Web` })
                    .setTimestamp();

                  await cardMsg.edit({ embeds: [doneEmbed], components: [] }).catch(() => null);
                }
              } catch {}
            }

            // Kirim pesan perayaan ke thread
            await (channel as any).send({
              content: `🎉 **TUGAS SELESAI DARI WEB!**\nTugas **"${task.title}"** telah ditandai **SELESAI** melalui Web Dashboard oleh **${actor}**! (+50 XP diberikan)`
            }).catch(() => null);

            // Cek apakah ada tugas aktif lain di thread ini
            if (channel.isThread()) {
              const remaining = await prisma.task.count({
                where: {
                  sourceChannelId: channel.id,
                  status: { in: ['TODO', 'IN_PROGRESS'] },
                  id: { not: task.id },
                  deletedAt: null
                }
              });

              if (remaining === 0) {
                await (channel as any).send({
                  content: `✨ *Seluruh tugas di thread ini telah tuntas! Thread otomatis diarsipkan dalam 3 detik.*`
                }).catch(() => null);

                setTimeout(async () => {
                  try {
                    if (channel.isThread() && !channel.archived) {
                      await channel.setArchived(true, 'Semua tugas telah selesai via Web Dashboard');
                    }
                  } catch {}
                }, 3000);
              }
            }
          } else {
            // Status berubah ke selain DONE (misal: IN_PROGRESS atau TODO)
            if (channel.isThread() && channel.archived) {
              await channel.setArchived(false).catch(() => null);
            }

            const statusLabels: Record<string, string> = {
              IN_PROGRESS: '▶️ Sedang Dikerjakan (In Progress)',
              TODO: '⏸️ Belum Dikerjakan (Todo)',
              CANCELLED: '🚫 Dibatalkan'
            };

            await (channel as any).send({
              content: `🔄 **Status Diperbarui:** Tugas **"${task.title}"** diubah menjadi **${statusLabels[newStatus] || newStatus}** melalui Web Dashboard oleh **${actor}**.`
            }).catch(() => null);
          }
        }
      }

      return true;
    } catch (err) {
      logger.error({ err, taskId, newStatus }, 'Gagal syncTaskStatusToDiscord');
      return false;
    }
  }

  /**
   * 🗑️ Sinkronisasi Penghapusan Tugas dari Web Dashboard ke Discord
   * Mengupdate kartu embed, membatalkan reminder, mengupdate Live Radar,
   * dan mengarsipkan thread jika kosong.
   */
  static async syncTaskDeleteToDiscord(
    taskId: string,
    client: Client,
    actorUsername?: string
  ): Promise<boolean> {
    try {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: { user: true, guild: true }
      });
      if (!task) return false;

      // Batalkan antrian reminder
      await this.cancelTaskReminders(taskId);

      // Update radar di Discord server
      if (task.guild?.discordGuildId) {
        const discordGuild = client.guilds.cache.get(task.guild.discordGuildId) ||
          await client.guilds.fetch(task.guild.discordGuildId).catch(() => null);
        if (discordGuild) {
          await GuildService.updateRadarDashboard(discordGuild, client);
        }
      }

      // Notifikasi & update kartu di thread
      if (task.sourceChannelId) {
        const channel = await client.channels.fetch(task.sourceChannelId).catch(() => null);
        if (channel && 'send' in channel) {
          const actor = actorUsername || task.user.username || 'Mahasiswa';

          // Update pesan kartu jika ada
          if (task.sourceMessageId && 'messages' in channel) {
            try {
              const cardMsg = await (channel as any).messages.fetch(task.sourceMessageId).catch(() => null);
              if (cardMsg && cardMsg.editable) {
                const delEmbed = new EmbedBuilder()
                  .setTitle(`🗑️ [DIHAPUS] ~~${task.title}~~`)
                  .setDescription(`Tugas ini telah **dihapus** melalui Web Dashboard oleh **${actor}**.`)
                  .setColor('#FF3366')
                  .setTimestamp();
                await cardMsg.edit({ embeds: [delEmbed], components: [] }).catch(() => null);
              }
            } catch {}
          }

          // Kirim pesan notifikasi ke thread
          await (channel as any).send({
            content: `🗑️ **Tugas Dihapus:** Tugas **"${task.title}"** telah dihapus via Web Dashboard oleh **${actor}**.`
          }).catch(() => null);

          // Jika thread kosong, arsipkan
          if (channel.isThread()) {
            const remaining = await prisma.task.count({
              where: {
                sourceChannelId: channel.id,
                status: { in: ['TODO', 'IN_PROGRESS'] },
                deletedAt: null
              }
            });

            if (remaining === 0) {
              setTimeout(async () => {
                try {
                  if (channel.isThread() && !channel.archived) {
                    await channel.setArchived(true, 'Tugas terakhir di thread telah dihapus');
                  }
                } catch {}
              }, 3000);
            }
          }
        }
      }

      return true;
    } catch (err) {
      logger.error({ err, taskId }, 'Gagal syncTaskDeleteToDiscord');
      return false;
    }
  }

  /**
   * ☑️ Sinkronisasi Toggle Subtask dari Web Dashboard ke Discord
   * Memperbarui checklist di kartu embed thread Discord & memberi info ke anggota.
   */
  static async syncSubtaskToggleToDiscord(
    subtaskId: string,
    client: Client,
    actorUsername?: string
  ): Promise<boolean> {
    try {
      const subtask = await prisma.subtask.findUnique({
        where: { id: subtaskId },
        include: {
          task: {
            include: {
              user: true,
              guild: true,
              subtasks: { orderBy: { position: 'asc' } }
            }
          }
        }
      });
      if (!subtask || !subtask.task) return false;
      const task = subtask.task;

      if (task.sourceChannelId) {
        const channel = await client.channels.fetch(task.sourceChannelId).catch(() => null);
        if (channel && 'send' in channel) {
          const actor = actorUsername || task.user.username || 'Mahasiswa';
          const isDone = subtask.status === 'DONE';

          // Update kartu tugas embed jika ada
          if (task.sourceMessageId && 'messages' in channel) {
            try {
              const cardMsg = await (channel as any).messages.fetch(task.sourceMessageId).catch(() => null);
              if (cardMsg && cardMsg.editable && cardMsg.embeds.length > 0) {
                const isGroup = task.taskType === 'GROUP';
                const deadlineText = task.dueAt
                  ? `<t:${Math.floor(task.dueAt.getTime() / 1000)}:F> (<t:${Math.floor(task.dueAt.getTime() / 1000)}:R>)`
                  : 'Tidak ada batas waktu';

                const memberListText = task.assignedUserIds && task.assignedUserIds.length > 0
                  ? task.assignedUserIds.map(id => (/^\d{16,20}$/.test(id) ? `<@${id}>` : id)).join(', ')
                  : `<@${task.user.discordId}>`;

                const subtaskText = task.subtasks.length > 0
                  ? '\n\n**Subtasks / Checklist:**\n' +
                    task.subtasks.map(s => `• ${s.status === 'DONE' ? '✅' : '⬜'} ${s.status === 'DONE' ? `~~${s.title}~~` : s.title}`).join('\n')
                  : '';

                const embed = new EmbedBuilder()
                  .setTitle(cardMsg.embeds[0].title || task.title)
                  .setDescription(
                    `### **${task.title}**\n\n` +
                    `🏷️ **Tipe:** **${isGroup ? '👥 Tugas Kelompok' : '👤 Tugas Individu'}**\n` +
                    (task.courseId ? `📚 **Mata Kuliah:** ${task.courseId}\n` : '') +
                    `👥 **Anggota:** ${memberListText}\n` +
                    `⏰ **Deadline:** ${deadlineText}\n` +
                    `🔥 **Prioritas:** ${task.priority}` +
                    (task.description ? `\n\n📝 **Catatan:** ${task.description}` : '') +
                    subtaskText
                  )
                  .setColor(cardMsg.embeds[0].color || (isGroup ? 0x9B59B6 : 0x00E5FF))
                  .setFooter({ text: `TaskFlow OS Web Sync • ID: ${task.id.slice(-6)}` });

                await cardMsg.edit({ embeds: [embed] }).catch(() => null);
              }
            } catch {}
          }

          // Kirim pesan kecil di thread
          await (channel as any).send({
            content: `☑️ Sub-tugas **"${subtask.title}"** ditandai ${isDone ? '**SELESAI ✅**' : '**BELUM SELESAI ⬜**'} oleh **${actor}** via Web Dashboard.`
          }).catch(() => null);
        }
      }

      return true;
    } catch (err) {
      logger.error({ err, subtaskId }, 'Gagal syncSubtaskToggleToDiscord');
      return false;
    }
  }

  /**
   * ⏰ Sinkronisasi Snooze Tugas dari Web Dashboard ke Discord
   */
  static async syncTaskSnoozeToDiscord(
    taskId: string,
    client: Client,
    minutes: number,
    actorUsername?: string
  ): Promise<boolean> {
    try {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: { guild: true, user: true }
      });
      if (!task) return false;

      if (task.guild?.discordGuildId) {
        const discordGuild = client.guilds.cache.get(task.guild.discordGuildId) ||
          await client.guilds.fetch(task.guild.discordGuildId).catch(() => null);
        if (discordGuild) {
          await GuildService.updateRadarDashboard(discordGuild, client);
        }
      }

      if (task.sourceChannelId) {
        const channel = await client.channels.fetch(task.sourceChannelId).catch(() => null);
        if (channel && 'send' in channel) {
          const actor = actorUsername || task.user.username || 'Mahasiswa';
          await (channel as any).send({
            content: `⏰ **Pengingat Ditunda:** Pengingat tugas **"${task.title}"** ditunda selama **${minutes} menit** oleh **${actor}** via Web Dashboard.`
          }).catch(() => null);
        }
      }

      return true;
    } catch (err) {
      logger.error({ err, taskId }, 'Gagal syncTaskSnoozeToDiscord');
      return false;
    }
  }

  /**
   * ✏️ Sinkronisasi Edit Tugas dari Web Dashboard ke Discord
   */
  static async syncTaskEditToDiscord(
    taskId: string,
    client: Client,
    actorUsername?: string
  ): Promise<boolean> {
    try {
      const task = await prisma.task.findUnique({
        where: { id: taskId },
        include: {
          user: true,
          guild: true,
          subtasks: { orderBy: { position: 'asc' } }
        }
      });
      if (!task) return false;

      // Update Live Radar
      if (task.guild?.discordGuildId) {
        const discordGuild = client.guilds.cache.get(task.guild.discordGuildId) ||
          await client.guilds.fetch(task.guild.discordGuildId).catch(() => null);
        if (discordGuild) {
          await GuildService.updateRadarDashboard(discordGuild, client);
        }
      }

      // Update kartu embed & thread
      if (task.sourceChannelId) {
        const channel = await client.channels.fetch(task.sourceChannelId).catch(() => null);
        if (channel && 'send' in channel) {
          const actor = actorUsername || task.user.username || 'Mahasiswa';

          if (task.sourceMessageId && 'messages' in channel) {
            try {
              const cardMsg = await (channel as any).messages.fetch(task.sourceMessageId).catch(() => null);
              if (cardMsg && cardMsg.editable) {
                const isGroup = task.taskType === 'GROUP';
                const deadlineText = task.dueAt
                  ? `<t:${Math.floor(task.dueAt.getTime() / 1000)}:F> (<t:${Math.floor(task.dueAt.getTime() / 1000)}:R>)`
                  : 'Tidak ada batas waktu';

                const memberListText = task.assignedUserIds && task.assignedUserIds.length > 0
                  ? task.assignedUserIds.map(id => (/^\d{16,20}$/.test(id) ? `<@${id}>` : id)).join(', ')
                  : `<@${task.user.discordId}>`;

                const subtaskText = task.subtasks.length > 0
                  ? '\n\n**Subtasks / Checklist:**\n' +
                    task.subtasks.map(s => `• ${s.status === 'DONE' ? '✅' : '⬜'} ${s.status === 'DONE' ? `~~${s.title}~~` : s.title}`).join('\n')
                  : '';

                const embed = new EmbedBuilder()
                  .setTitle(isGroup ? '👥 Task Kelompok (Diperbarui)' : '👤 Task Individu (Diperbarui)')
                  .setDescription(
                    `### **${task.title}**\n\n` +
                    `🏷️ **Tipe:** **${isGroup ? '👥 Tugas Kelompok' : '👤 Tugas Individu'}**\n` +
                    (task.courseId ? `📚 **Mata Kuliah:** ${task.courseId}\n` : '') +
                    `👥 **Anggota:** ${memberListText}\n` +
                    `⏰ **Deadline:** ${deadlineText}\n` +
                    `🔥 **Prioritas:** ${task.priority}` +
                    (task.description ? `\n\n📝 **Catatan:** ${task.description}` : '') +
                    subtaskText
                  )
                  .setColor(isGroup ? '#9B59B6' : '#00E5FF')
                  .setFooter({ text: `TaskFlow OS Web Sync • ID: ${task.id.slice(-6)} • Diperbarui via Web` });

                await cardMsg.edit({ embeds: [embed] }).catch(() => null);
              }
            } catch {}
          }

          await (channel as any).send({
            content: `✏️ **Detail Tugas Diperbarui:** Tugas **"${task.title}"** telah diperbarui via Web Dashboard oleh **${actor}**.`
          }).catch(() => null);
        }
      }

      return true;
    } catch (err) {
      logger.error({ err, taskId }, 'Gagal syncTaskEditToDiscord');
      return false;
    }
  }
}


