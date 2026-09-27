import { prisma } from '../../database/prisma';
import { logger } from '../../shared/utils/logger';

export interface AuditEventPayload {
  userId: string;
  eventType:
    | 'TASK_CREATE'
    | 'TASK_COMPLETE'
    | 'TASK_STATUS_UPDATE'
    | 'TASK_DELETE'
    | 'TASK_SNOOZE'
    | 'ROLE_CHANGE'
    | 'ANNOUNCEMENT_BROADCAST'
    | 'CACHE_FLUSH'
    | 'SETTINGS_UPDATE';
  taskId?: string;
  metadata?: Record<string, any>;
}

export class AuditLogService {
  /**
   * Mencatat riwayat aksi pengguna/admin ke tabel activity_logs
   */
  static async record(params: AuditEventPayload) {
    try {
      return await prisma.activityLog.create({
        data: {
          userId: params.userId,
          taskId: params.taskId,
          eventType: params.eventType,
          metadata: params.metadata || {},
        },
      });
    } catch (err) {
      logger.warn({ err, params }, 'Gagal menyimpan Audit Log');
      return null;
    }
  }

  /**
   * Mengambil daftar riwayat aktivitas terbaru untuk Panel Admin
   */
  static async getRecentLogs(limit = 50) {
    try {
      return await prisma.activityLog.findMany({
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          user: {
            select: {
              id: true,
              username: true,
              discordId: true,
              role: true,
            },
          },
        },
      });
    } catch (err) {
      logger.error({ err }, 'Gagal mengambil Audit Logs');
      return [];
    }
  }
}
