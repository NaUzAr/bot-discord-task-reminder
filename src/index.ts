import { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel, AttachmentBuilder } from 'discord.js';
import { env } from './config/env';
import { logger } from './shared/utils/logger';
import { deployCommands } from './bot/deploy-commands';
import { AIService } from './modules/ai/ai.service';
import { TaskService } from './modules/task/task.service';
import { GuildService } from './modules/guild/guild.service';
import { prisma } from './database/prisma';
import { generateGoogleCalendarUrl } from './shared/utils/calendar';
import { BriefingService } from './modules/briefing/briefing.service';
import { ExportService } from './modules/export/export.service';

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

  // Update Live Radar Dashboard & Guide di semua server saat bot online
  for (const [, guild] of client.guilds.cache) {
    await GuildService.updateRadarDashboard(guild);
    const dbGuild = await prisma.guild.findUnique({ where: { discordGuildId: guild.id } });
    if (dbGuild?.inboxChannelId) {
      const inboxCh = guild.channels.cache.get(dbGuild.inboxChannelId) as TextChannel | undefined;
      if (inboxCh) await GuildService.updateInboxGuide(guild, inboxCh, dbGuild.radarChannelId || undefined);
    }
  }

  // ☀️ Mulai scheduler Daily Morning Briefing (07:00 WIB)
  BriefingService.startScheduler(client);
});

// 📥 AUTO-LISTEN: Mendengarkan pesan obrolan di channel inbox-tugas secara otomatis
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const channelName = (message.channel as TextChannel).name?.toLowerCase() || '';
  const isInbox = channelName.includes('inbox') || channelName.includes('tugas');

  const hasAttachment = message.attachments.size > 0;
  if (!isInbox) return;
  if (message.content.trim().length < 3 && !hasAttachment) return;

  try {
    await message.react('👀');

    // 👥 Deteksi anggota yang di-tag (Tugas Kelompok vs Individu)
    const mentionedUsers = message.mentions.users.filter(u => !u.bot && u.id !== message.author.id);
    const isGroup = mentionedUsers.size > 0;
    const taskType: 'GROUP' | 'INDIVIDUAL' = isGroup ? 'GROUP' : 'INDIVIDUAL';
    const assignedUserIds = [message.author.id, ...Array.from(mentionedUsers.keys())];

    // Bersihkan mention <@...> agar caption yang dikirim ke AI tetap bersih
    const cleanContent = message.content.replace(/<@!?\d+>/g, '').trim();

    // 📸 Vision AI: Cek apakah pengguna mengunggah gambar/screenshot
    const imageAttachment = message.attachments.find(att => att.contentType?.startsWith('image/'));
    let extracted = null;

    if (imageAttachment) {
      try {
        const response = await fetch(imageAttachment.url);
        const arrayBuffer = await response.arrayBuffer();
        const imageBuffer = Buffer.from(arrayBuffer);
        extracted = await AIService.extractTaskFromImage(
          imageBuffer,
          imageAttachment.contentType || 'image/png',
          cleanContent
        );
      } catch (imgErr) {
        logger.error({ imgErr }, 'Gagal mengunduh atau mengekstrak task dari gambar');
      }
    } else {
      extracted = await AIService.extractTask(cleanContent.length >= 3 ? cleanContent : message.content);
    }

    if (!extracted) {
      await message.reactions.cache.get('👀')?.users.remove(client.user?.id);
      return;
    }

    // Buat Discord Thread otomatis dengan badge pembeda
    const threadPrefix = isGroup ? '👥 [Kelompok]' : '👤 [Individu]';
    let thread = message.thread;
    if (!thread) {
      try {
        thread = await message.startThread({
          name: `${threadPrefix} ${extracted.title.slice(0, 80)}`,
          autoArchiveDuration: 1440
        });
      } catch (threadErr) {
        logger.warn({ threadErr }, 'Failed to start thread on message');
      }
    }

    // Jika tugas kelompok, masukkan semua anggota yang di-tag ke dalam thread
    if (thread && isGroup) {
      for (const [userId] of mentionedUsers) {
        await thread.members.add(userId).catch(() => null);
      }
    }

    const task = await TaskService.createTaskFromAI(
      message.author.id,
      message.author.username,
      extracted,
      {
        guildId: message.guild.id,
        guildName: message.guild.name,
        sourceType: 'INBOX_MESSAGE',
        sourceMessageId: message.id,
        sourceChannelId: thread ? thread.id : message.channel.id,
        taskType,
        assignedUserIds
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

    if (task.linkUrl) {
      buttons.push(
        new ButtonBuilder()
          .setLabel('Buka Link')
          .setStyle(ButtonStyle.Link)
          .setURL(task.linkUrl)
          .setEmoji('🔗')
      );
    }

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);

    const embedColor = isGroup ? '#9B59B6' : '#00E5FF';
    const embedTitle = isGroup 
      ? '👥 Task Kelompok Terdeteksi dari Inbox!' 
      : '👤 Task Individu Terdeteksi dari Inbox!';

    const memberListText = isGroup
      ? assignedUserIds.map(id => `<@${id}>`).join(', ')
      : `<@${message.author.id}>`;

    const embed = new EmbedBuilder()
      .setTitle(embedTitle)
      .setDescription(
        `### **${task.title}**\n\n` +
        `🏷️ **Tipe:** **${isGroup ? '👥 Tugas Kelompok' : '👤 Tugas Individu'}**\n` +
        `👥 **Anggota:** ${memberListText}\n` +
        `⏰ **Deadline:** ${deadlineText}\n` +
        `🔥 **Prioritas:** ${task.priority}`
      )
      .setColor(embedColor);

    if (task.linkUrl) {
      embed.addFields({
        name: '🔗 Tempat Pengumpulan',
        value: `[Klik untuk Membuka Tautan Pengumpulan](${task.linkUrl})`,
        inline: false
      });
    }

    embed
      .setFooter({ text: isGroup ? 'Tugas Kelompok • Anggota tim otomatis diundang ke thread & diingatkan!' : 'Klik "AI Breakdown" untuk memecah tugas jadi checklist praktis!' })
      .setTimestamp();

    const targetChannel = thread || message.channel;
    await targetChannel.send({ embeds: [embed], components: [row] });

    if (thread) {
      const groupNote = isGroup ? ` (👥 Anggota: ${mentionedUsers.map(u => `<@${u.id}>`).join(', ')})` : '';
      const replyMsg = await message.reply({
        content: `✅ **Task ${isGroup ? 'Kelompok' : 'Individu'} Dicatat!** Buka thread <#${thread.id}> untuk rincian, AI breakdown, dan aksi tugas.${groupNote}\n*(Pesan ini otomatis hilang dalam 2 menit agar channel tetap bersih)*`
      });
      // Bersihkan notifikasi bot di channel inbox-tugas setelah 2 menit (120.000 ms) agar chat tetap bersih
      setTimeout(async () => {
        try {
          await replyMsg.delete();
        } catch {
          // Abaikan jika sudah dihapus secara manual
        }
      }, 2 * 60 * 1000);
    }

    // Perbarui Live Radar Dashboard di channel deadline-radar secara realtime
    await GuildService.updateRadarDashboard(message.guild);
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

      const isInsideThread = interaction.channel?.isThread();

      const doneEmbed = new EmbedBuilder()
        .setTitle('✅ Task Telah Selesai!')
        .setDescription(
          `~~${updated.title}~~\n\n🎉 Kerja bagus! Tugas ini telah ditandai selesai (+50 XP) dan reminder dibatalkan.` +
          (isInsideThread ? '\n\n🗑️ *Thread ini akan otomatis dihapus permanen dalam 3 detik...*' : '')
        )
        .setColor('#00FF7F')
        .setTimestamp();

      await interaction.editReply({ embeds: [doneEmbed], components: [] });

      // Proses hapus thread & pesan asli chat di inbox secara permanen jika tugas selesai
      const deleteThreadIfExists = async () => {
        try {
          let threadToDelete: any = null;
          let parentChannel: any = null;

          if (isInsideThread) {
            threadToDelete = interaction.channel;
            parentChannel = (interaction.channel as any)?.parent;
          } else if (updated.sourceChannelId) {
            const ch = await client.channels.fetch(updated.sourceChannelId).catch(() => null);
            if (ch?.isThread()) {
              threadToDelete = ch;
              parentChannel = ch.parent;
            } else if (ch && 'messages' in ch) {
              parentChannel = ch;
              if (updated.sourceMessageId && 'threads' in ch) {
                const msg = await (ch as any).messages.fetch(updated.sourceMessageId).catch(() => null);
                if (msg?.thread) {
                  threadToDelete = msg.thread;
                }
              }
            }
          }

          if (threadToDelete) {
            if (!isInsideThread) {
              const closingEmbed = new EmbedBuilder()
                .setTitle('🗑️ Thread Tugas Selesai')
                .setDescription('🎉 Tugas ini telah diselesaikan! Thread ini akan dihapus permanen dalam 3 detik...')
                .setColor('#00FF7F');
              await threadToDelete.send({ embeds: [closingEmbed] }).catch(() => null);
            }

            await new Promise((resolve) => setTimeout(resolve, 3000));
            await threadToDelete.delete('Tugas telah diselesaikan oleh user');
            logger.info(`Thread ${threadToDelete.id} berhasil dihapus permanen karena task ${updated.id} selesai.`);
          }

          // Hapus pesan chat asli pengguna di channel utama agar inbox-tugas 100% bersih!
          if (updated.sourceMessageId && parentChannel) {
            const sourceMsg = await parentChannel.messages.fetch(updated.sourceMessageId).catch(() => null);
            if (sourceMsg) {
              await sourceMsg.delete().catch(() => null);
              logger.info(`Pesan chat asli ${updated.sourceMessageId} di inbox-tugas berhasil dihapus.`);
            }
          }

          // Perbarui Live Radar Dashboard secara realtime
          if (updated.guildId) {
            const dbG = await prisma.guild.findUnique({ where: { id: updated.guildId } });
            if (dbG) await GuildService.updateRadarDashboard(dbG.discordGuildId, client);
          } else if (interaction.guild) {
            await GuildService.updateRadarDashboard(interaction.guild);
          }
        } catch (err) {
          logger.warn({ err }, 'Gagal menghapus thread/pesan task yang selesai');
        }
      };

      deleteThreadIfExists();
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
        `• 📥 <#${res.inboxChannel.id}> (Auto-listen chat tugas + Auto-thread rapi)\n` +
        `• 🚨 <#${res.radarChannel.id}> (Papan radar deadline - Read Only)\n\n` +
        `*Silakan coba ketik tugas di channel <#${res.inboxChannel.id}>!*`
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
      const task = await TaskService.createTaskFromAI(
        interaction.user.id,
        interaction.user.username,
        extracted,
        {
          guildId: interaction.guildId ?? undefined,
          guildName: interaction.guild?.name
        }
      );
      
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
            const typeBadge = t.taskType === 'GROUP' ? '👥 [Kelompok]' : '👤 [Individu]';
            return `**${idx + 1}. ${typeBadge} ${t.title}**\n${priorityEmoji[t.priority] || '⚡'} Prioritas: **${t.priority}** | ⏰ Deadline: ${dl}${linkText}`;
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
          OR: [
            { user: { discordId: interaction.user.id } },
            { assignedUserIds: { has: interaction.user.id } }
          ],
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
            const typeBadge = t.taskType === 'GROUP' ? '👥 [Kelompok]' : '👤 [Individu]';
            return `**${i + 1}. ${typeBadge} ${t.title}**\n⏰ <t:${Math.floor(t.dueAt!.getTime() / 1000)}:R> - 🔥 ${t.priority}${linkText}`;
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

  // /briefing - Kirim Morning Briefing langsung ke channel radar sekarang
  if (interaction.commandName === 'briefing') {
    await interaction.deferReply({ ephemeral: true });
    if (!interaction.guild) {
      await interaction.editReply('❌ Command ini hanya bisa dijalankan di dalam Server (Guild).');
      return;
    }

    try {
      await BriefingService.sendMorningBriefing(client, interaction.guild.id);
      await interaction.editReply('☀️ **Daily Morning Briefing berhasil dikirimkan ke channel radar server!**');
    } catch (err) {
      logger.error({ err }, 'Gagal mengirim briefing via slash command');
      await interaction.editReply('❌ Terjadi kesalahan saat mengirim briefing.');
    }
  }

  // /rekap - Export rekap tugas format rapi untuk WhatsApp/Telegram
  if (interaction.commandName === 'rekap') {
    await interaction.deferReply();
    const cakupan = interaction.options.getString('cakupan') || 'server';

    try {
      let tasks: any[] = [];
      let scopeTitle = '';

      if (cakupan === 'saya') {
        scopeTitle = `Tugas Pribadi (${interaction.user.username})`;
        tasks = await TaskService.getUserActiveTasks(interaction.user.id, 20);
      } else {
        if (!interaction.guild) {
          await interaction.editReply('❌ Opsi rekap server hanya bisa digunakan di dalam server.');
          return;
        }
        scopeTitle = `Server ${interaction.guild.name}`;
        const dbGuild = await prisma.guild.findUnique({
          where: { discordGuildId: interaction.guild.id }
        });

        if (dbGuild) {
          tasks = await prisma.task.findMany({
            where: {
              guildId: dbGuild.id,
              status: { in: ['TODO', 'IN_PROGRESS'] },
              deletedAt: null
            },
            include: { user: true },
            orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }],
            take: 25
          });
        }
      }

      const waText = ExportService.formatWhatsAppRekap(tasks, scopeTitle, client);

      const previewEmbed = new EmbedBuilder()
        .setTitle(`📋 Rekap Tugas Siap Copas (${scopeTitle})`)
        .setColor('#25D366') // WhatsApp Brand Color
        .setDescription(
          'Gunakan blok teks di bawah ini atau download file terlampir untuk langsung dibagikan ke WhatsApp / Telegram grup kelasmu!\n\n' +
          '```text\n' + (waText.length > 3900 ? waText.slice(0, 3850) + '\n\n...(Dipotong, cek file lampiran untuk teks lengkap)...' : waText) + '\n```'
        )
        .setFooter({ text: 'Klik icon salin di pojok kanan atas blok teks untuk copy instan!' })
        .setTimestamp();

      const attachment = new AttachmentBuilder(Buffer.from(waText, 'utf-8'), {
        name: `rekap-tugas-${cakupan === 'saya' ? 'pribadi' : 'server'}.txt`
      });

      await interaction.editReply({
        embeds: [previewEmbed],
        files: [attachment]
      });
    } catch (err) {
      logger.error({ err }, 'Gagal generate rekap tugas');
      await interaction.editReply('❌ Gagal membuat rekap tugas.');
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

