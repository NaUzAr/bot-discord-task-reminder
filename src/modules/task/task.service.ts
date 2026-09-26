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

    return session;
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
