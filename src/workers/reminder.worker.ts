import { Worker } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../shared/utils/logger';
import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { prisma } from '../database/prisma';

// Worker menggunakan client Discord sendiri untuk mengirim DM
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.login(env.BOT_TOKEN);

export const reminderWorker = new Worker('reminder-queue', async (job) => {
  const { taskId, userId, title } = job.data;
  
  logger.info(`Memproses reminder untuk task: ${taskId}`);

  try {
    // Cek apakah task masih ada dan belum selesai
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status === 'DONE' || task.status === 'CANCELLED') {
      logger.info(`Task ${taskId} sudah selesai/dibatalkan. Batal mengirim reminder.`);
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: task.userId } });
    if (!user) return;

    // Ambil object user Discord untuk mengirim Direct Message (DM)
    const discordUser = await client.users.fetch(user.discordId);
    
    // Buat tampilan UI Embed yang cantik untuk Discord
    const embed = new EmbedBuilder()
      .setTitle('⏰ Waktunya Nugas!')
      .setDescription(`Jangan lupa kerjain: **${task.title}**`)
      .setColor('#FF5733')
      .addFields(
        { name: 'Prioritas', value: task.priority, inline: true },
        { name: 'Status', value: task.status, inline: true }
      )
      .setTimestamp();

    await discordUser.send({ embeds: [embed] });
    
    // Catat riwayat reminder ke database
    await prisma.reminder.create({
      data: {
        taskId: task.id,
        userId: user.id,
        reminderAt: new Date(),
        status: 'SENT'
      }
    });

  } catch (err) {
    logger.error({ err, taskId }, 'Gagal mengirim reminder DM');
    throw err; // Lempar error agar BullMQ secara otomatis me-retry job ini nanti
  }
}, {
  connection: { url: env.REDIS_URL }
});

reminderWorker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} gagal dengan error: ${err.message}`);
});
