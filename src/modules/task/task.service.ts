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

  static async createTaskFromAI(
    discordId: string, 
    username: string, 
    extracted: ExtractedTask,
    metadata?: {
      guildId?: string;
      sourceType?: string;
      sourceMessageId?: string;
      sourceChannelId?: string;
    }
  ): Promise<Task> {
    const user = await this.getOrCreateUser(discordId, username);

    const dueAtDate = extracted.dueAt ? new Date(extracted.dueAt) : null;

    // 1. Simpan Task ke Database
    const task = await prisma.task.create({
      data: {
        userId: user.id,
        guildId: metadata?.guildId,
        title: extracted.title,
        dueAt: dueAtDate,
        estimatedMinutes: extracted.estimatedMinutes,
        priority: extracted.priority || 'MEDIUM',
        status: 'TODO',
        sourceType: metadata?.sourceType,
        sourceMessageId: metadata?.sourceMessageId,
        sourceChannelId: metadata?.sourceChannelId
      }
    });

    // 2. Jika ada deadline, daftarkan penjadwalan reminder ke BullMQ (Redis)
    if (dueAtDate) {
      // Set reminder H-1 Jam sebelum deadline
      const reminderTime = subMinutes(dueAtDate, 60);
      const delay = reminderTime.getTime() - Date.now();
      
      // Jika delay > 0 jadwalkan H-1 jam, jika waktu tersisa < 1 jam tapi masih di masa depan, jadwalkan langsung
      const effectiveDelay = delay > 0 ? delay : Math.max(0, dueAtDate.getTime() - Date.now() - 5 * 60 * 1000);

      if (effectiveDelay > 0) {
        await reminderQueue.add('send-reminder', {
          taskId: task.id,
          userId: user.id,
          title: task.title
        }, {
          delay: effectiveDelay,
          jobId: `reminder_${task.id}`
        });
        logger.info(`Reminder dijadwalkan untuk task ${task.id} dalam ${effectiveDelay}ms`);
      }
    }

    // Catat ke Activity Log
    await prisma.activityLog.create({
      data: {
        userId: user.id,
        taskId: task.id,
        eventType: 'TASK_CREATED',
        metadata: { title: task.title, dueAt: task.dueAt, priority: task.priority }
      }
    });

    return task;
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

    // Batalkan scheduled reminder job jika masih ada di BullMQ
    try {
      const job = await reminderQueue.getJob(`reminder_${taskId}`);
      if (job) {
        await job.remove();
        logger.info(`Scheduled reminder job for task ${taskId} removed.`);
      }
    } catch (err) {
      logger.warn({ err }, `Could not remove reminder job for task ${taskId}`);
    }

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

    await reminderQueue.add('send-reminder', {
      taskId: task.id,
      userId: task.userId,
      title: task.title
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
        deliveryType: 'DM'
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

  static async startFocusSession(taskId: string, userId: string, durationMinutes: number = 25) {
    const session = await prisma.focusSession.create({
      data: {
        taskId,
        userId,
        startedAt: new Date(),
        durationMinutes
      }
    });

    // Jadwalkan notifikasi saat sesi fokus selesai
    const delay = durationMinutes * 60 * 1000;
    await reminderQueue.add('focus-end', {
      sessionId: session.id,
      userId,
      taskId,
      durationMinutes
    }, {
      delay,
      jobId: `focus_${session.id}`
    });

    await prisma.activityLog.create({
      data: {
        userId,
        taskId,
        eventType: 'FOCUS_STARTED',
        metadata: { durationMinutes }
      }
    });

    // Beri +25 XP atas komitmen fokus
    await this.addXP(userId, 25);

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
        user: { discordId },
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
}
