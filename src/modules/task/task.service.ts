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

  static async createTaskFromAI(discordId: string, username: string, extracted: ExtractedTask): Promise<Task> {
    const user = await this.getOrCreateUser(discordId, username);

    const dueAtDate = extracted.dueAt ? new Date(extracted.dueAt) : null;

    // 1. Simpan Task ke Database
    const task = await prisma.task.create({
      data: {
        userId: user.id,
        title: extracted.title,
        dueAt: dueAtDate,
        estimatedMinutes: extracted.estimatedMinutes,
        priority: extracted.priority || 'MEDIUM',
        status: 'TODO'
      }
    });

    // 2. Jika ada deadline, daftarkan penjadwalan reminder ke BullMQ (Redis)
    if (dueAtDate) {
      // Set reminder H-1 Jam sebelum deadline
      const reminderTime = subMinutes(dueAtDate, 60);
      const delay = reminderTime.getTime() - Date.now();
      
      // Hanya jadwalkan jika waktunya masih di masa depan
      if (delay > 0) {
        await reminderQueue.add('send-reminder', {
          taskId: task.id,
          userId: user.id,
          title: task.title
        }, {
          delay,
          jobId: `reminder_${task.id}` // Deterministic ID agar mudah di-cancel jika task selesai duluan
        });
        logger.info(`Reminder dijadwalkan untuk task ${task.id} dalam ${delay}ms`);
      }
    }

    return task;
  }
}
