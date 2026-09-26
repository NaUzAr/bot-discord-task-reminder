import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import { env } from './config/env';
import { logger } from './shared/utils/logger';
import { deployCommands } from './bot/deploy-commands';
import { AIService } from './modules/ai/ai.service';
import { TaskService } from './modules/task/task.service';
import { GuildService } from './modules/guild/guild.service';
import { prisma } from './database/prisma';

// 🔄 Menyalakan BullMQ Worker secara otomatis saat bot berjalan!
import './workers/reminder.worker'; 

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ]
});

client.once('clientReady', async () => {
  logger.info(`🤖 Bot is ready! Logged in as ${client.user?.tag}`);
  if (client.user) {
    const guildIds = client.guilds.cache.map(g => g.id);
    await deployCommands(client.user.id, guildIds);
  }
});

// 📥 AUTO-LISTEN: Mendengarkan pesan obrolan di channel inbox-tugas secara otomatis
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const channelName = (message.channel as TextChannel).name?.toLowerCase() || '';
  const isInbox = channelName.includes('inbox') || channelName.includes('tugas');

  if (!isInbox) return;
  if (message.content.trim().length < 5) return;

  try {
    await message.react('👀');

    const extracted = await AIService.extractTask(message.content);
    if (!extracted) {
      await message.reactions.cache.get('👀')?.users.remove(client.user?.id);
      return;
    }

    const task = await TaskService.createTaskFromAI(
      message.author.id,
      message.author.username,
      extracted,
      {
        guildId: message.guild.id,
        sourceType: 'INBOX_MESSAGE',
        sourceMessageId: message.id,
        sourceChannelId: message.channel.id
      }
    );

    await message.reactions.cache.get('👀')?.users.remove(client.user?.id);
    await message.react('✅');

    const deadlineText = task.dueAt 
      ? `<t:${Math.floor(task.dueAt.getTime() / 1000)}:F> (<t:${Math.floor(task.dueAt.getTime() / 1000)}:R>)` 
      : 'Tidak ada batas waktu';

    const buttons = [
      new ButtonBuilder()
        .setCustomId(`task_done_${task.id}`)
        .setLabel('Selesai')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
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

    const embed = new EmbedBuilder()
      .setTitle('📌 Task Otomatis Terdeteksi dari Inbox!')
      .setDescription(
        `### **${task.title}**\n\n` +
        `⏰ **Deadline:** ${deadlineText}\n` +
        `🔥 **Prioritas:** ${task.priority}\n` +
        `👤 **Pembuat:** <@${message.author.id}>`
      )
      .setColor('#00E5FF');

    if (task.linkUrl) {
      embed.addFields({
        name: '🔗 Tempat Pengumpulan',
        value: `[Klik untuk Membuka Tautan Pengumpulan](${task.linkUrl})`,
        inline: false
      });
    }

    embed
      .setFooter({ text: 'Klik "AI Breakdown" untuk memecah tugas ini jadi checklist praktis!' })
      .setTimestamp();

    await message.reply({ embeds: [embed], components: [row] });
  } catch (err) {
    logger.error({ err }, 'Error in auto-listen inbox');
  }
});

client.on('interactionCreate', async (interaction) => {
  // 🔘 1. Tangani Interaksi Tombol (Done, Snooze, Focus, Breakdown)
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
        .setDescription(`~~${updated.title}~~\n\n🎉 Kerja bagus! Tugas ini telah ditandai selesai (+50 XP) dan reminder dibatalkan.`)
        .setColor('#00FF7F')
        .setTimestamp();

      await interaction.editReply({ embeds: [doneEmbed], components: [] });
      return;
    }

    // Tombol: AI Task Breakdown
    if (customId.startsWith('task_breakdown_')) {
      const taskId = customId.replace('task_breakdown_', '');
      await interaction.deferReply({ ephemeral: true });

      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task) {
        await interaction.editReply('❌ Task tidak ditemukan.');
        return;
      }

      const subtaskTitles = await AIService.breakdownTask(task.title);
      const subtasks = await TaskService.createSubtasks(task.id, subtaskTitles);

      const breakdownEmbed = new EmbedBuilder()
        .setTitle(`🧩 AI Task Breakdown: ${task.title}`)
        .setDescription(
          'AI telah memecah tugas ini menjadi langkah-langkah praktis:\n\n' +
          subtasks.map((s, idx) => `⬜ **${idx + 1}.** ${s.title}`).join('\n')
        )
        .setColor('#9B59B6')
        .setFooter({ text: 'Checklist ini tersimpan di database TaskFlow' });

      await interaction.editReply({ embeds: [breakdownEmbed] });
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

    // Tombol: Focus Session (25m / 50m)
    if (customId.startsWith('task_focus_') || customId.startsWith('room_focus_')) {
      const duration = customId.includes('50') ? 50 : 25;
      await interaction.deferReply({ ephemeral: true });
      await TaskService.startFocusSession('', interaction.user.id, duration);

      const focusEmbed = new EmbedBuilder()
        .setTitle('🎯 Sesi Fokus Dimulai!')
        .setDescription(
          `Waktu fokus: **${duration} menit** (+${duration === 25 ? 25 : 50} XP)\n` +
          'Matikan distraksi dan selamat produktif! Bot akan otomatis mengirim DM saat waktu istirahat tiba! ☕'
        )
        .setColor('#00FF7F')
        .setTimestamp();

      await interaction.editReply({ embeds: [focusEmbed] });
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
          .setColor('#00E5FF');

        if (task.linkUrl) {
          embed.addFields({
            name: '🔗 Tempat Pengumpulan',
            value: `[Klik untuk Membuka Tautan Pengumpulan](${task.linkUrl})`
          });
        }

        embed.addFields({
          name: 'Pesan Asli',
          value: `[Loncat ke Pesan](https://discord.com/channels/${interaction.guildId || '@me'}/${targetMessage.channelId}/${targetMessage.id})`
        }).setTimestamp();

        const contextButtons = [];
        if (task.linkUrl) {
          contextButtons.push(
            new ButtonBuilder()
              .setLabel('Buka Link Tugas')
              .setStyle(ButtonStyle.Link)
              .setURL(task.linkUrl)
              .setEmoji('🔗')
          );
        }
        const contextRow = contextButtons.length > 0 
          ? [new ActionRowBuilder<ButtonBuilder>().addComponents(contextButtons)] 
          : [];

        await interaction.editReply({ embeds: [embed], components: contextRow });
      } catch (err) {
        logger.error({ err }, 'Gagal membuat task dari context menu');
        await interaction.editReply('❌ Terjadi kesalahan saat menyimpan tugas.');
      }
    }
    return;
  }

  // ⌨️ 3. Tangani Slash Commands
  if (!interaction.isChatInputCommand()) return;

  // /setup - Otomatis Bangun TaskFlow OS Kategori & Channel di Server
  if (interaction.commandName === 'setup') {
    await interaction.deferReply();
    if (!interaction.guild) {
      await interaction.editReply('❌ Command ini hanya bisa dijalankan di dalam Server (Guild).');
      return;
    }

    try {
      const res = await GuildService.setupGuildOS(interaction.guild);
      await interaction.editReply(
        `✅ **TaskFlow OS Workspace Berhasil Dibangun!**\n\n` +
        `📁 **Kategori:** \`${res.category.name}\`\n` +
        `• 📥 <#${res.inboxChannel.id}> (Auto-listen chat tugas aktif)\n` +
        `• 🚨 <#${res.radarChannel.id}> (Papan radar deadline & reminder)\n` +
        `• 🎯 <#${res.focusChannel.id}> (Ruang Pomodoro bersama)\n` +
        `• 🏆 <#${res.leaderboardChannel.id}> (Papan peringkat XP & Streak)\n\n` +
        `*Silakan coba ketik pengumuman tugas di channel <#${res.inboxChannel.id}>!*`
      );
    } catch (err) {
      logger.error({ err }, 'Gagal setup guild OS');
      await interaction.editReply('❌ Gagal membangun channel. Pastikan bot memiliki izin Manage Channels / Administrator di server ini.');
    }
  }

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

      const embed = new EmbedBuilder()
        .setTitle('✅ Task Berhasil Dibuat & Reminder Dijadwalkan!')
        .setDescription(`📌 **Judul:** ${task.title}\n⏰ **Deadline:** ${deadlineText}\n🔥 **Prioritas:** ${task.priority}`)
        .setColor('#00FF7F');

      if (task.linkUrl) {
        embed.addFields({
          name: '🔗 Tempat Pengumpulan',
          value: `[Klik untuk Membuka Tautan Pengumpulan](${task.linkUrl})`
        });
      }

      const taskButtons = [];
      if (task.linkUrl) {
        taskButtons.push(
          new ButtonBuilder()
            .setLabel('Buka Link Tugas')
            .setStyle(ButtonStyle.Link)
            .setURL(task.linkUrl)
            .setEmoji('🔗')
        );
      }
      const taskRow = taskButtons.length > 0 
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(taskButtons)] 
        : [];

      await interaction.editReply({ embeds: [embed], components: taskRow });
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
            const linkText = t.linkUrl ? ` | 🔗 [Link](${t.linkUrl})` : '';
            return `**${idx + 1}. ${t.title}**\n${priorityEmoji[t.priority] || '⚡'} Prioritas: **${t.priority}** | ⏰ Deadline: ${dl}${linkText}`;
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
          tasks.map((t, i) => {
            const linkText = t.linkUrl ? ` | 🔗 [Link](${t.linkUrl})` : '';
            return `**${i + 1}. ${t.title}**\n⏰ <t:${Math.floor(t.dueAt!.getTime() / 1000)}:R> - 🔥 ${t.priority}${linkText}`;
          }).join('\n\n')
        );

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error({ err }, 'Gagal mengambil data today');
      await interaction.editReply('❌ Gagal mengambil data.');
    }
  }

  if (interaction.commandName === 'stats') {
    await interaction.deferReply();
    const stats = await TaskService.getUserStats(interaction.user.id);
    if (!stats) {
      await interaction.editReply('Kamu belum memiliki riwayat aktivitas di TaskFlow.');
      return;
    }

    const embed = new EmbedBuilder()
      .setTitle(`📊 Profil Produktivitas: ${stats.username}`)
      .setColor('#00E5FF')
      .addFields(
        { name: '⭐ Level', value: `Level **${stats.level}**`, inline: true },
        { name: '✨ Total XP', value: `**${stats.xp}** XP`, inline: true },
        { name: '🔥 Daily Streak', value: `**${stats.streak}** Hari`, inline: true },
        { name: '✅ Tugas Selesai', value: `**${stats.completedTasks}** / ${stats.totalTasks}`, inline: true },
        { name: '⏱️ Total Fokus', value: `**${stats.totalFocusMinutes}** Menit`, inline: true }
      )
      .setFooter({ text: 'Selesaikan tugas tepat waktu untuk menambah XP & Streak!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
  }

  if (interaction.commandName === 'leaderboard') {
    await interaction.deferReply();
    const topUsers = await TaskService.getLeaderboard(10);

    if (topUsers.length === 0) {
      await interaction.editReply('Belum ada data di leaderboard.');
      return;
    }

    const medals = ['🥇', '🥈', '🥉'];
    const embed = new EmbedBuilder()
      .setTitle('🏆 Leaderboard Produktivitas TaskFlow')
      .setColor('#F1C40F')
      .setDescription(
        topUsers.map((u, i) => {
          const rank = medals[i] || `**#${i + 1}**`;
          return `${rank} **${u.username}** — ⭐ **${u.xp}** XP | 🔥 **${u.streak}** Hari Streak`;
        }).join('\n\n')
      )
      .setFooter({ text: 'Raih posisi teratas dengan produktif setiap hari!' })
      .setTimestamp();

    await interaction.editReply({ embeds: [embed] });
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

