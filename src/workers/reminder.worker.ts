import { Worker } from 'bullmq';
import { env } from '../config/env';
import { logger } from '../shared/utils/logger';
import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import { prisma } from '../database/prisma';
import { generateGoogleCalendarUrl } from '../shared/utils/calendar';

// Worker menggunakan client Discord sendiri untuk mengirim notifikasi thread & DM
const client = new Client({ 
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.DirectMessages
  ] 
});
client.login(env.BOT_TOKEN);

export const reminderWorker = new Worker('reminder-queue', async (job) => {
  // 🎯 1. Tangani Notifikasi Sesi Fokus Selesai (Pomodoro End)
  if (job.name === 'focus-end') {
    const { userId, discordId, durationMinutes, guildId, taskId } = job.data;
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;
      const targetDiscordId = discordId || user.discordId;

      // A. Copot role @In Focus di guild & kirim pengumuman selamat di fokus-room
      if (guildId) {
        try {
          const guild = await client.guilds.fetch(guildId).catch(() => null);
          if (guild) {
            const member = await guild.members.fetch(targetDiscordId).catch(() => null);
            const focusRole = guild.roles.cache.find(r => r.name.toLowerCase().includes('in focus'));
            if (member && focusRole) {
              await member.roles.remove(focusRole).catch(() => null);
              logger.info(`Role @In Focus berhasil dilepas dari user ${targetDiscordId}`);
            }

            // Kirim perayaan di channel fokus jika ada
            const dbGuild = await prisma.guild.findUnique({ where: { discordGuildId: guildId } });
            if (dbGuild?.focusChannelId) {
              const focusChannel = await guild.channels.fetch(dbGuild.focusChannelId).catch(() => null);
              if (focusChannel && 'send' in focusChannel) {
                const congratEmbed = new EmbedBuilder()
                  .setTitle('🎉 Sesi Deep Work Selesai!')
                  .setDescription(
                    `🎉 <@${targetDiscordId}> telah menyelesaikan sesi fokus **${durationMinutes} menit**! (+${durationMinutes >= 50 ? 50 : 25} XP)\n` +
                    `Status \`@In Focus\` telah dinonaktifkan. Istirahat sejenak 5 menit ya! ☕`
                  )
                  .setColor('#00FF7F')
                  .setTimestamp();
                await (focusChannel as any).send({ embeds: [congratEmbed] });
              }
            }
          }
        } catch (gErr) {
          logger.warn({ gErr }, 'Gagal mengelola role In Focus di guild saat focus-end');
        }
      }

      // B. Kirim ucapan selamat via DM ke pengguna dengan tombol istirahat 5 menit
      const discordUser = await client.users.fetch(targetDiscordId).catch(() => null);
      if (discordUser) {
        const embed = new EmbedBuilder()
          .setTitle('🎉 25 Menit Tuntas! (Sesi Fokus Sukses 🍅)')
          .setDescription(
            `Hebat! Kamu telah menyelesaikan sesi fokus selama **${durationMinutes} menit** (+${durationMinutes >= 50 ? 50 : 25} XP)!\n\n` +
            `Saatnya rehat 5 menit:\n` +
            `• Berdiri & regangkan badanmu 🧘\n` +
            `• Ambil segelas air putih 💧\n` +
            `• Istirahatkan mata sejenak dari layar\n\n` +
            `*Klik tombol di bawah untuk memulai waktu istirahat:*`
          )
          .setColor('#00FF7F')
          .setTimestamp();

        const breakButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(taskId ? `focus_break_5_${taskId}` : 'focus_break_5')
            .setLabel('☕ Mulai Istirahat 5 Menit')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(taskId ? `task_focus_${taskId}_25` : 'room_focus_25')
            .setLabel('🍅 Skip & Lanjut Fokus')
            .setStyle(ButtonStyle.Secondary)
        );

        await discordUser.send({ embeds: [embed], components: [breakButtons] }).catch(() => null);
      }
    } catch (err) {
      logger.error({ err }, 'Gagal mengirim notifikasi focus-end');
    }
    return;
  }

  // ☕ 1b. Tangani Notifikasi Istirahat Selesai (Break End)
  if (job.name === 'break-end') {
    const { userId, discordId, taskId } = job.data;
    try {
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) return;
      const targetDiscordId = discordId || user.discordId;
      const discordUser = await client.users.fetch(targetDiscordId).catch(() => null);

      if (discordUser) {
        const breakEndEmbed = new EmbedBuilder()
          .setTitle('⏰ Waktu Istirahat 5 Menit Selesai!')
          .setDescription(
            'Badan dan pikiran sudah lebih segar? Saatnya kembali produktif!\n\n' +
            'Siap memulai putaran fokus berikutnya? 🚀'
          )
          .setColor('#00E5FF')
          .setTimestamp();

        const resumeButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(taskId ? `task_focus_${taskId}_25` : 'room_focus_25')
            .setLabel('🎯 Mulai Fokus 25m')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId(taskId ? `task_focus_${taskId}_50` : 'room_focus_50')
            .setLabel('🔥 Deep Work 50m')
            .setStyle(ButtonStyle.Primary)
        );

        await discordUser.send({ embeds: [breakEndEmbed], components: [resumeButtons] }).catch(() => null);
      }
    } catch (err) {
      logger.error({ err }, 'Gagal mengirim notifikasi break-end');
    }
    return;
  }

  // ⏰ 2. Tangani Notifikasi Pengingat Tugas (3-Stage Multi-Alert di Thread & DM)
  const { taskId, stageId, stageTitle, stageDesc, color, channelId, taskType } = job.data;
  logger.info(`Memproses reminder untuk task: ${taskId} (Stage: ${stageId || 'DEFAULT'})`);

  try {
    const task = await prisma.task.findUnique({ 
      where: { id: taskId },
      include: { subtasks: true }
    });

    if (!task || task.status === 'DONE' || task.status === 'CANCELLED') {
      logger.info(`Task ${taskId} sudah selesai/dibatalkan. Batal mengirim reminder.`);
      return;
    }

    const deadlineInfo = task.dueAt 
      ? `<t:${Math.floor(task.dueAt.getTime() / 1000)}:R> (<t:${Math.floor(task.dueAt.getTime() / 1000)}:F>)`
      : 'Tidak ada batas waktu';

    const isGroup = task.taskType === 'GROUP';

    // Format progres checklist subtask jika ada
    let subtaskProgressText = '';
    if (task.subtasks && task.subtasks.length > 0) {
      const done = task.subtasks.filter(s => s.status === 'DONE').length;
      const total = task.subtasks.length;
      const percent = Math.round((done / total) * 100);
      const filled = Math.round(percent / 10);
      const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
      subtaskProgressText = `\n📊 **Progres Checklist:** \`[${bar}]\` **${percent}%** (${done}/${total} Selesai)`;
    }

    // Tombol interaktif untuk reminder
    const buttons = [
      new ButtonBuilder()
        .setCustomId(`task_done_${task.id}`)
        .setLabel('Selesai')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`task_focus_${task.id}_25`)
        .setLabel('Fokus 25m')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎯'),
      new ButtonBuilder()
        .setCustomId(`task_snooze_${task.id}_30`)
        .setLabel('Tunda 30m')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('💤')
    ];

    if (task.linkUrl) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('Buka Link')
          .setStyle(ButtonStyle.Link)
          .setURL(task.linkUrl)
          .setEmoji('🔗')
      );
    }

    if (task.dueAt) {
      const gcalUrl = generateGoogleCalendarUrl(task.title, task.dueAt, task.linkUrl);
      buttons.push(
        new ButtonBuilder()
          .setLabel('Google Calendar')
          .setStyle(ButtonStyle.Link)
          .setURL(gcalUrl)
          .setEmoji('📅')
      );
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons.slice(0, 5));

    const reminderEmbed = new EmbedBuilder()
      .setTitle(stageTitle || (isGroup ? '👥 Reminder Tugas Kelompok!' : '⏰ Reminder Tugas!'))
      .setDescription(
        `### **${task.title}**\n\n` +
        `${stageDesc || 'Waktunya menyelesaikan tugas ini!'}\n\n` +
        `⏰ **Deadline:** ${deadlineInfo}` +
        subtaskProgressText +
        `\n🔥 **Prioritas:** ${task.priority}` +
        `\n🏷️ **Tipe:** ${isGroup ? '👥 Tugas Kelompok' : '👤 Tugas Individu'}` +
        (task.description ? `\n\n📝 **Catatan Format:**\n${task.description.length > 300 ? task.description.slice(0, 297) + '...' : task.description}` : '')
      )
      .setColor(color || (isGroup ? '#9B59B6' : '#FF5733'))
      .setFooter({ text: `TaskFlow OS • Stage Reminder (${stageId || 'ALERT'})` })
      .setTimestamp();

    // 🔔 A. KIRIMKAN REMINDER KE THREAD TUGAS
    const targetChannelId = channelId || task.sourceChannelId;
    if (targetChannelId) {
      try {
        const chan = await client.channels.fetch(targetChannelId).catch(() => null);
        if (chan && 'send' in chan) {
          const mentionText = task.assignedUserIds.map(id => `<@${id}>`).join(' ');
          await (chan as any).send({
            content: mentionText ? `🔔 **Pengingat Tugas:** ${mentionText}` : undefined,
            embeds: [reminderEmbed],
            components: [row]
          });
          logger.info(`Reminder ${stageId || 'DEFAULT'} berhasil dikirim ke thread/channel ${targetChannelId}`);
        }
      } catch (cErr) {
        logger.warn({ cErr }, `Gagal mengirim reminder ke thread/channel ${targetChannelId}`);
      }
    }

    // 📩 B. KIRIMKAN JUGA DM KE SELURUH ANGGOTA YANG DI-ASSIGN
    for (const assigneeId of task.assignedUserIds) {
      try {
        const discordUser = await client.users.fetch(assigneeId).catch(() => null);
        if (discordUser) {
          await discordUser.send({ embeds: [reminderEmbed], components: [row] }).catch(() => null);
        }
      } catch (dmErr) {
        logger.warn({ dmErr, assigneeId }, 'Gagal mengirim DM reminder');
      }
    }

    // C. Catat riwayat reminder ke database
    await prisma.reminder.create({
      data: {
        taskId: task.id,
        userId: task.userId,
        reminderAt: new Date(),
        deliveryType: targetChannelId ? 'THREAD_AND_DM' : 'DM',
        deliveryChannelId: targetChannelId || null,
        status: 'SENT',
        sentAt: new Date()
      }
    });

  } catch (err) {
    logger.error({ err, taskId }, 'Gagal memproses reminder');
    throw err;
  }
}, {
  connection: { url: env.REDIS_URL }
});

reminderWorker.on('failed', (job, err) => {
  logger.error(`Job ${job?.id} gagal dengan error: ${err.message}`);
});
