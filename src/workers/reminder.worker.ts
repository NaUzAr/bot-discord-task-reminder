import { Worker } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../shared/utils/logger';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { prisma } from '../database/prisma';

// Worker menggunakan client Discord sendiri untuk mengirim DM
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.login(env.BOT_TOKEN);

export const reminderWorker = new Worker('reminder-queue', async (job) => {
  if (job.name === 'focus-end') {
    const { userId, durationMinutes } = job.data;
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;
      const discordUser = await client.users.fetch(user.discordId);

      const embed = new EmbedBuilder()
        .setTitle('🎉 Sesi Fokus Selesai!')
        .setDescription(`Hebat! Kamu telah menyelesaikan sesi fokus selama **${durationMinutes} menit**.\nIstirahat sejenak 5 menit ya! ☕`)
        .setColor('#00FF7F')
        .setTimestamp();

      await discordUser.send({ embeds: [embed] });
    } catch (err) {
      logger.error({ err }, 'Gagal mengirim notifikasi focus-end');
    }
    return;
  }

  const { taskId, userId, title } = job.data;
  
  logger.info(`Memproses reminder untuk task: ${taskId}`);

  try {
    // Cek apakah task masih ada dan belum selesai
    const task = await prisma.task.findUnique({ where: { id: taskId } });
    if (!task || task.status === 'DONE' || task.status === 'CANCELLED') {
      logger.info(`Task ${taskId} sudah selesai/dibatalkan. Batal mengirim reminder.`);
      return;
    }

    const user = await prisma.user.findUnique({ where: { id: userId || task.userId } });
    if (!user) return;

    // Ambil object user Discord untuk mengirim Direct Message (DM)
    const discordUser = await client.users.fetch(user.discordId);
    
    // ActionRow tombol interaktif: Selesai, Tunda 30m, Fokus 25m
    const buttons = [
      new ButtonBuilder()
        .setCustomId(`task_done_${task.id}`)
        .setLabel('Selesai')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`task_snooze_${task.id}_30`)
        .setLabel('Tunda 30m')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('💤'),
      new ButtonBuilder()
        .setCustomId(`task_focus_${task.id}_25`)
        .setLabel('Fokus 25m')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎯')
    ];

    if (task.linkUrl) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('Buka Link Tugas')
          .setStyle(ButtonStyle.Link)
          .setURL(task.linkUrl)
          .setEmoji('🔗')
      );
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

    const deadlineInfo = task.dueAt 
      ? `<t:${Math.floor(task.dueAt.getTime() / 1000)}:R> (<t:${Math.floor(task.dueAt.getTime() / 1000)}:F>)`
      : 'Tidak ada batas waktu';

    const isGroup = task.taskType === 'GROUP';

    // Buat tampilan UI Embed yang cantik untuk Discord
    const embed = new EmbedBuilder()
      .setTitle(isGroup ? '👥 Waktunya Nugas Bareng! (Reminder Kelompok)' : '⏰ Waktunya Nugas! (TaskFlow Reminder)')
      .setDescription(`Jangan lupa kerjakan tugas ${isGroup ? 'kelompok' : ''}:\n### **${task.title}**\n\n⏰ **Deadline:** ${deadlineInfo}`)
      .setColor(isGroup ? '#9B59B6' : '#FF5733')
      .addFields(
        { name: 'Tipe', value: isGroup ? '👥 Kelompok' : '👤 Individu', inline: true },
        { name: 'Prioritas', value: `🔥 ${task.priority}`, inline: true },
        { name: 'Status', value: `⚪ ${task.status}`, inline: true }
      );

    if (task.linkUrl) {
      embed.addFields({
        name: '🔗 Tempat Pengumpulan',
        value: `[Klik untuk Membuka Tautan Pengumpulan](${task.linkUrl})`,
        inline: false
      });
    }

    embed
      .setFooter({ text: 'Klik tombol di bawah untuk aksi cepat!' })
      .setTimestamp();

    await discordUser.send({ embeds: [embed], components: [row] });
    
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
