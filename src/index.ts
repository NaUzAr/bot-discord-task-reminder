import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { env } from './config/env';
import { logger } from './shared/utils/logger';
import { deployCommands } from './bot/deploy-commands';
import { AIService } from './modules/ai/ai.service';
import { TaskService } from './modules/task/task.service';
import { prisma } from './database/prisma';

// 🔄 Menyalakan BullMQ Worker secara otomatis saat bot berjalan!
import './workers/reminder.worker'; 

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ]
});

client.once('clientReady', async () => {
  logger.info(`🤖 Bot is ready! Logged in as ${client.user?.tag}`);
  if (client.user) {
    await deployCommands(client.user.id);
  }
});

client.on('interactionCreate', async (interaction) => {
  // 🔘 1. Tangani Interaksi Tombol (Done, Snooze, Focus)
  if (interaction.isButton()) {
    const { customId } = interaction;

    // Tombol: Selesai
    if (customId.startsWith('task_done_')) {
      const taskId = customId.replace('task_done_', '');
      await interaction.deferUpdate();

      const updated = await TaskService.markTaskDone(taskId);
      if (!updated) {
        await interaction.followUp({ content: '❌ Task tidak ditemukan atau sudah selesai.', ephemeral: true });
        return;
      }

      const doneEmbed = new EmbedBuilder()
        .setTitle('✅ Task Telah Selesai!')
        .setDescription(`~~${updated.title}~~\n\n🎉 Kerja bagus! Tugas ini telah ditandai selesai dan reminder dibatalkan.`)
        .setColor('#00FF7F')
        .setTimestamp();

      await interaction.editReply({ embeds: [doneEmbed], components: [] });
      return;
    }

    // Tombol: Snooze (Tunda 30m)
    if (customId.startsWith('task_snooze_')) {
      const parts = customId.split('_');
      const taskId = parts[2];
      const minutes = parseInt(parts[3] || '30', 10);

      await interaction.deferUpdate();
      const nextTime = await TaskService.snoozeTask(taskId, minutes);

      if (!nextTime) {
        await interaction.followUp({ content: '❌ Gagal menunda task atau task sudah selesai.', ephemeral: true });
        return;
      }

      const snoozeEmbed = new EmbedBuilder()
        .setTitle('💤 Reminder Ditunda')
        .setDescription(`Reminder untuk tugas ini ditunda selama **${minutes} menit**.\nPengingat berikutnya: <t:${Math.floor(nextTime.getTime() / 1000)}:R>`)
        .setColor('#F1C40F')
        .setTimestamp();

      await interaction.editReply({ embeds: [snoozeEmbed], components: [] });
      return;
    }

    // Tombol: Focus Session (25m)
    if (customId.startsWith('task_focus_')) {
      const parts = customId.split('_');
      const taskId = parts[2];
      const minutes = parseInt(parts[3] || '25', 10);

      await interaction.deferReply({ ephemeral: true });
      await TaskService.startFocusSession(taskId, interaction.user.id, minutes);

      await interaction.editReply(`🎯 **Sesi Fokus Dimulai (${minutes} menit)!**\nJauhkan distraksi, fokuslah pada tugas ini. Bot akan mengirimkan notifikasi saat waktunya habis! 💪`);
      return;
    }
  }

  // 🖱️ 2. Tangani Context Menu Command (Klik Kanan Pesan -> Add to TaskFlow)
  if (interaction.isMessageContextMenuCommand()) {
    if (interaction.commandName === 'Add to TaskFlow') {
      await interaction.deferReply({ ephemeral: true });

      const targetMessage = interaction.targetMessage;
      const text = targetMessage.content;

      if (!text || text.trim().length === 0) {
        await interaction.editReply('❌ Pesan yang kamu pilih tidak memiliki teks yang bisa diproses.');
        return;
      }

      const extracted = await AIService.extractTask(text);
      if (!extracted) {
        await interaction.editReply('❌ AI tidak dapat mendeteksi tugas atau deadline dari pesan tersebut.');
        return;
      }

      try {
        const task = await TaskService.createTaskFromAI(
          interaction.user.id,
          interaction.user.username,
          extracted,
          {
            guildId: interaction.guildId ?? undefined,
            sourceType: 'DISCORD_MESSAGE',
            sourceMessageId: targetMessage.id,
            sourceChannelId: targetMessage.channelId
          }
        );

        const deadlineText = task.dueAt 
          ? `<t:${Math.floor(task.dueAt.getTime() / 1000)}:F> (<t:${Math.floor(task.dueAt.getTime() / 1000)}:R>)` 
          : 'Tidak ada batas waktu';

        const embed = new EmbedBuilder()
          .setTitle('📥 Task Berhasil Dibuat dari Pesan!')
          .setDescription(`📌 **Judul:** ${task.title}\n⏰ **Deadline:** ${deadlineText}\n🔥 **Prioritas:** ${task.priority}`)
          .setColor('#00E5FF')
          .addFields({
            name: 'Pesan Asli',
            value: `[Loncat ke Pesan](https://discord.com/channels/${interaction.guildId || '@me'}/${targetMessage.channelId}/${targetMessage.id})`
          })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        logger.error({ err }, 'Gagal membuat task dari context menu');
        await interaction.editReply('❌ Terjadi kesalahan saat menyimpan tugas.');
      }
    }
    return;
  }

  // ⌨️ 3. Tangani Slash Commands
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === 'task') {
    await interaction.deferReply();
    
    const userInput = interaction.options.getString('input', true);
    const extracted = await AIService.extractTask(userInput);
    
    if (!extracted) {
      await interaction.editReply('❌ Maaf, AI gagal memahami instruksimu. Coba gunakan kalimat yang lebih spesifik.');
      return;
    }

    try {
      const task = await TaskService.createTaskFromAI(interaction.user.id, interaction.user.username, extracted);
      
      const deadlineText = task.dueAt 
        ? `<t:${Math.floor(task.dueAt.getTime() / 1000)}:F> (<t:${Math.floor(task.dueAt.getTime() / 1000)}:R>)` 
        : 'Tidak ada batas waktu';

      await interaction.editReply(`✅ **Task Berhasil Dibuat & Reminder Dijadwalkan!**\n\n📌 **Judul:** ${task.title}\n⏰ **Deadline:** ${deadlineText}\n🔥 **Prioritas:** ${task.priority}`);
    } catch (err) {
      logger.error({ err }, 'Gagal menyimpan task ke database');
      await interaction.editReply('❌ Terjadi kesalahan saat menyimpan ke database.');
    }
  }

  if (interaction.commandName === 'tasks') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const tasks = await TaskService.getUserActiveTasks(interaction.user.id, 10);

      if (tasks.length === 0) {
        await interaction.editReply('🎉 Yeay! Kamu tidak memiliki tugas aktif saat ini. Waktunya santai!');
        return;
      }

      const priorityEmoji: Record<string, string> = {
        URGENT: '🚨',
        HIGH: '🔥',
        MEDIUM: '⚡',
        LOW: '🌱'
      };

      const embed = new EmbedBuilder()
        .setTitle('📋 Daftar Tugas Aktif Kamu')
        .setColor('#5865F2')
        .setDescription(
          tasks.map((t, idx) => {
            const dl = t.dueAt ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R>` : 'Tanpa deadline';
            return `**${idx + 1}. ${t.title}**\n${priorityEmoji[t.priority] || '⚡'} Prioritas: **${t.priority}** | ⏰ Deadline: ${dl}`;
          }).join('\n\n')
        )
        .setFooter({ text: 'Klik tombol di bawah untuk menyelesaikan tugas' });

      const buttons = tasks.slice(0, 5).map((t, i) =>
        new ButtonBuilder()
          .setCustomId(`task_done_${t.id}`)
          .setLabel(`Selesai #${i + 1}`)
          .setStyle(ButtonStyle.Success)
      );

      const rows = [];
      if (buttons.length > 0) {
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(buttons));
      }

      await interaction.editReply({ embeds: [embed], components: rows });
    } catch (err) {
      logger.error({ err }, 'Gagal mengambil daftar tasks');
      await interaction.editReply('❌ Gagal mengambil daftar tugas.');
    }
  }

  if (interaction.commandName === 'today') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const tasks = await prisma.task.findMany({
        where: {
          user: { discordId: interaction.user.id },
          dueAt: { gte: startOfDay, lte: endOfDay },
          status: 'TODO'
        },
        orderBy: { dueAt: 'asc' }
      });

      if (tasks.length === 0) {
        await interaction.editReply('🎉 Yeay! Kamu tidak punya tugas yang deadline hari ini.');
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle('🚨 Deadline Radar (HARI INI)')
        .setColor('#FFCC00')
        .setDescription(
          tasks.map((t, i) => `**${i + 1}. ${t.title}**\n⏰ <t:${Math.floor(t.dueAt!.getTime() / 1000)}:R> - 🔥 ${t.priority}`).join('\n\n')
        );

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error({ err }, 'Gagal mengambil data today');
      await interaction.editReply('❌ Gagal mengambil data.');
    }
  }
});

async function bootstrap() {
  try {
    logger.info('Starting TaskFlow Bot...');
    await client.login(env.BOT_TOKEN);
  } catch (error) {
    logger.error({ err: error }, 'Failed to start bot');
    process.exit(1);
  }
}

bootstrap();
