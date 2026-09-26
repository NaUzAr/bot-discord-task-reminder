import { Queue } from 'bullmq';
import { env } from '../config/env';

// Inisialisasi antrean (queue) menggunakan Redis
export const reminderQueue = new Queue('reminder-queue', {
  connection: {
    url: env.REDIS_URL
  }
});
