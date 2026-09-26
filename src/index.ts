import { 
  Client, 
  GatewayIntentBits, 
  EmbedBuilder, 
  ActionRowBuilder, 
  ButtonBuilder, 
  ButtonStyle, 
  TextChannel, 
  AttachmentBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder
} from 'discord.js';
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
    // Bersihkan pesan lama tertinggal di inbox saat bot online
    await GuildService.cleanInboxChannel(guild);
  }

  // 🧹 Maintenance Garbage Collection: bersihkan inbox setiap 1 jam (bukan per detik) agar hemat resource & bebas rate-limit
  setInterval(async () => {
    for (const [, guild] of client.guilds.cache) {
      await GuildService.cleanInboxChannel(guild, client, 30);
    }
  }, 60 * 60 * 1000);

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

  // 🧹 Event-Driven Clean: Bersihkan pesan usang HANYA di channel server ini saat ada aktivitas (Zero beban ke server lain)
  GuildService.cleanInboxChannel(message.guild, client, 20).catch(() => null);

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

    // 📸 Vision AI & 🎙️ Voice-to-Task: Cek apakah pengguna mengunggah gambar/screenshot atau voice note/audio
    const imageAttachment = message.attachments.find(att => att.contentType?.startsWith('image/'));
    const audioAttachment = message.attachments.find(att => 
      att.contentType?.startsWith('audio/') || 
      att.name.endsWith('.ogg') || 
      att.name.endsWith('.mp3') || 
      att.name.endsWith('.wav') ||
      att.name.endsWith('.m4a')
    );
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
    } else if (audioAttachment) {
      try {
        const response = await fetch(audioAttachment.url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = Buffer.from(arrayBuffer);
        extracted = await AIService.extractTaskFromAudio(
          audioBuffer,
          audioAttachment.contentType || 'audio/ogg',
          cleanContent
        );
      } catch (audioErr) {
        logger.error({ audioErr }, 'Gagal mengunduh atau mengekstrak task dari audio/voice note');
      }
    } else {
      extracted = await AIService.extractTask(cleanContent.length >= 3 ? cleanContent : message.content);
    }

    if (!extracted) {
      await message.reactions.cache.get('👀')?.users.remove(client.user?.id);
      const warnMsg = await message.reply({
        content: '⚠️ AI belum dapat mendeteksi rincian tugas atau deadline dari pesan ini. Pastikan menyertakan nama tugas dan waktu (contoh: *"Laporan Kalkulus besok jam 8 malam"*).\n*(Pesan ini otomatis dihapus dalam 8 detik agar inbox tetap bersih)*'
      }).catch(() => null);

      setTimeout(async () => {
        try {
          if (warnMsg) await warnMsg.delete().catch(() => null);
          await message.delete().catch(() => null);
        } catch {}
      }, 8 * 1000);
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

    const primaryButtons = [
      new ButtonBuilder()
        .setCustomId(`task_done_${task.id}`)
        .setLabel('Selesai')
        .setStyle(ButtonStyle.Success)
        .setEmoji('✅'),
      new ButtonBuilder()
        .setCustomId(`task_edit_${task.id}`)
        .setLabel('Edit')
        .setStyle(ButtonStyle.Secondary)
        .setEmoji('✏️'),
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

    const linkButtons = [];
    if (task.dueAt) {
      const gcalUrl = generateGoogleCalendarUrl(task.title, task.dueAt, task.linkUrl);
      linkButtons.push(
        new ButtonBuilder()
          .setLabel('Google Calendar')
          .setStyle(ButtonStyle.Link)
          .setURL(gcalUrl)
          .setEmoji('📅')
      );
    }

    if (task.linkUrl) {
      linkButtons.push(
        new ButtonBuilder()
          .setLabel('Buka Link')
          .setStyle(ButtonStyle.Link)
          .setURL(task.linkUrl)
          .setEmoji('🔗')
      );
    }

    const actionRows: ActionRowBuilder<ButtonBuilder>[] = [
      new ActionRowBuilder<ButtonBuilder>().addComponents(primaryButtons)
    ];
    if (linkButtons.length > 0) {
      actionRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(linkButtons));
    }

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
      .setFooter({ text: isGroup ? 'Tugas Kelompok • Anggota tim otomatis diundang ke thread & diingatkan!' : 'Klik "Edit" untuk ubah rincian, atau "AI Breakdown" untuk memecah tugas!' })
      .setTimestamp();

    const targetChannel = thread || message.channel;
    await targetChannel.send({ embeds: [embed], components: actionRows });

    if (thread) {
      const groupNote = isGroup ? ` (👥 Anggota: ${mentionedUsers.map(u => `<@${u.id}>`).join(', ')})` : '';
      const replyMsg = await message.reply({
        content: `✅ **Task ${isGroup ? 'Kelompok' : 'Individu'} Dicatat!** Buka thread <#${thread.id}> untuk rincian, AI breakdown, dan aksi tugas.${groupNote}\n*(Pesan input & notifikasi ini otomatis terhapus dalam 10 detik agar inbox tetap bersih)*`
      }).catch(() => null);

      // Bersihkan notifikasi bot & pesan input asli user di inbox-tugas setelah 10 detik (10.000 ms) agar inbox selalu 100% bersih!
      setTimeout(async () => {
        try {
          if (replyMsg) await replyMsg.delete().catch(() => null);
          await message.delete().catch(() => null);
        } catch {
          // Abaikan jika sudah dihapus
        }
      }, 10 * 1000);
    }

    // Perbarui Live Radar Dashboard di channel deadline-radar secara realtime
    await GuildService.updateRadarDashboard(message.guild);
  } catch (err) {
    logger.error({ err }, 'Error in auto-listen inbox');
  }
});

/**
 * 🧩 Render kartu checklist subtask interaktif dengan visual progress bar & toggle buttons
 */
function renderSubtasksChecklist(task: { title: string }, subtasks: any[]) {
  const doneCount = subtasks.filter(s => s.status === 'DONE').length;
  const total = subtasks.length;
  const percent = total > 0 ? Math.round((doneCount / total) * 100) : 0;
  const filledBars = Math.round(percent / 10);
  const progressBar = '█'.repeat(filledBars) + '░'.repeat(10 - filledBars);

  const subtaskLines = subtasks.map((s, idx) => {
    return s.status === 'DONE'
      ? `✅ ~~**${idx + 1}.** ${s.title}~~`
      : `⬜ **${idx + 1}.** ${s.title}`;
  }).join('\n');

  const breakdownEmbed = new EmbedBuilder()
    .setTitle(`🧩 Checklist Sub-Tugas: ${task.title}`)
    .setDescription(
      `📊 **Progress:** \`[${progressBar}]\` **${percent}%** (${doneCount}/${total} Selesai)\n\n` +
      subtaskLines +
      (percent === 100 
        ? '\n\n🎉 **Luar biasa! Seluruh sub-tugas telah selesai!** (+30 XP)\nTekan tombol `✅ Selesai` di atas jika tugas utama sudah rampung.' 
        : '\n\n*Klik tombol di bawah untuk mencentang/membatalkan sub-tugas:*')
    )
    .setColor(percent === 100 ? '#00FF7F' : '#9B59B6')
    .setFooter({ text: 'TaskFlow OS • Interactive Subtasks (Tersimpan di DB)' })
    .setTimestamp();

  const toggleButtons = subtasks.slice(0, 5).map((s, idx) =>
    new ButtonBuilder()
      .setCustomId(`subtask_toggle_${s.id}`)
      .setLabel(`#${idx + 1} ${s.status === 'DONE' ? '↩️ Batal' : '✔️ Centang'}`)
      .setStyle(s.status === 'DONE' ? ButtonStyle.Secondary : ButtonStyle.Primary)
  );

  const compRows = toggleButtons.length > 0
    ? [new ActionRowBuilder<ButtonBuilder>().addComponents(toggleButtons)]
    : [];

  return { embed: breakdownEmbed, components: compRows };
}

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
          let parentChannelId: string | null = null;

          if (isInsideThread) {
            threadToDelete = interaction.channel;
            parentChannelId = (interaction.channel as any)?.parentId || null;
          } else if (updated.sourceChannelId) {
            const ch = await client.channels.fetch(updated.sourceChannelId).catch(() => null);
            if (ch?.isThread()) {
              threadToDelete = ch;
              parentChannelId = ch.parentId;
            } else if (ch && 'messages' in ch) {
              parentChannelId = ch.id;
              if (updated.sourceMessageId && 'threads' in ch) {
                const msg = await (ch as any).messages.fetch(updated.sourceMessageId).catch(() => null);
                if (msg?.thread) {
                  threadToDelete = msg.thread;
                }
              }
            }
          }

          let dbG: any = null;
          if (updated.guildId) {
            dbG = await prisma.guild.findUnique({ where: { id: updated.guildId } });
            if (!parentChannelId && dbG?.inboxChannelId) {
              parentChannelId = dbG.inboxChannelId;
            }
          }

          // 1. Bersihkan pesan chat & notifikasi bot di inbox-tugas secara menyeluruh
          if (parentChannelId) {
            const parentChannel = await client.channels.fetch(parentChannelId).catch(() => null);
            if (parentChannel && 'messages' in parentChannel) {
              try {
                // Hapus pesan asli user jika masih ada
                if (updated.sourceMessageId) {
                  await (parentChannel as any).messages.delete(updated.sourceMessageId).catch(() => null);
                }
                // Cari dan hapus notifikasi bot yang me-reply atau menyebut thread ini
                const recent = await (parentChannel as any).messages.fetch({ limit: 25 }).catch(() => null);
                if (recent) {
                  for (const m of recent.values()) {
                    if (dbG?.inboxGuideMessageId && m.id === dbG.inboxGuideMessageId) continue;
                    const isRefSource = updated.sourceMessageId && m.reference?.messageId === updated.sourceMessageId;
                    const mentionsThread = threadToDelete && m.content?.includes(threadToDelete.id);
                    const isUserSource = updated.sourceMessageId && m.id === updated.sourceMessageId;
                    if (isRefSource || mentionsThread || isUserSource) {
                      await m.delete().catch(() => null);
                    }
                  }
                }
              } catch (cleanErr) {
                logger.warn({ cleanErr }, 'Gagal menghapus pesan inbox saat task selesai');
              }
            }
          }

          // 2. Beri pesan penutup di thread lalu hapus thread secara permanen
          if (threadToDelete) {
            if (!isInsideThread) {
              const closingEmbed = new EmbedBuilder()
                .setTitle('🗑️ Thread Tugas Selesai')
                .setDescription('🎉 Tugas ini telah diselesaikan! Thread ini akan dihapus permanen dalam 3 detik...')
                .setColor('#00FF7F');
              await threadToDelete.send({ embeds: [closingEmbed] }).catch(() => null);
            }

            await new Promise((resolve) => setTimeout(resolve, 3000));
            await threadToDelete.delete('Tugas telah diselesaikan oleh user').catch(() => null);
            logger.info(`Thread ${threadToDelete.id} berhasil dihapus permanen karena task ${updated.id} selesai.`);
          }

          // 3. Perbarui Live Radar Dashboard secara realtime
          if (dbG) {
            await GuildService.updateRadarDashboard(dbG.discordGuildId, client);
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

    // Tombol: AI Task Breakdown (Checklist Interaktif)
    if (customId.startsWith('task_breakdown_')) {
      const taskId = customId.replace('task_breakdown_', '');
      await interaction.deferReply();

      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task) {
        await interaction.editReply('❌ Task tidak ditemukan.');
        return;
      }

      let subtasks = await TaskService.getSubtasks(task.id);
      if (subtasks.length === 0) {
        const subtaskTitles = await AIService.breakdownTask(task.title);
        subtasks = await TaskService.createSubtasks(task.id, subtaskTitles);
      }

      const { embed, components } = renderSubtasksChecklist(task, subtasks);
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // Tombol: Toggle Status Subtask (Checklist Dicentang / Batal)
    if (customId.startsWith('subtask_toggle_')) {
      const subtaskId = customId.replace('subtask_toggle_', '');
      await interaction.deferUpdate();

      const toggled = await TaskService.toggleSubtask(subtaskId);
      if (!toggled) return;

      if (toggled.status === 'DONE') {
        await TaskService.addXP(interaction.user.id, 10);
      }

      const task = await prisma.task.findUnique({ where: { id: toggled.taskId } });
      if (!task) return;

      const subtasks = await TaskService.getSubtasks(toggled.taskId);
      const { embed, components } = renderSubtasksChecklist(task, subtasks);
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // Tombol: Edit Task (Menampilkan Discord Modal Pop-Up Form)
    if (customId.startsWith('task_edit_')) {
      const taskId = customId.replace('task_edit_', '');
      const task = await prisma.task.findUnique({ where: { id: taskId } });
      if (!task) {
        await interaction.reply({ content: '❌ Task tidak ditemukan.', ephemeral: true });
        return;
      }

      const modal = new ModalBuilder()
        .setCustomId(`modal_edit_task_${task.id}`)
        .setTitle('✏️ Edit Rincian Task');

      const titleInput = new TextInputBuilder()
        .setCustomId('title')
        .setLabel('Judul Tugas')
        .setStyle(TextInputStyle.Short)
        .setValue(task.title)
        .setRequired(true);

      const dueInput = new TextInputBuilder()
        .setCustomId('due')
        .setLabel('Deadline (Waktu / Kalimat Santai)')
        .setStyle(TextInputStyle.Short)
        .setPlaceholder('Contoh: Besok jam 8 malam atau 2026-09-30 20:00')
        .setValue(task.dueAt ? task.dueAt.toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' }) : '')
        .setRequired(false);

      const priorityInput = new TextInputBuilder()
        .setCustomId('priority')
        .setLabel('Prioritas (LOW / MEDIUM / HIGH / URGENT)')
        .setStyle(TextInputStyle.Short)
        .setValue(task.priority)
        .setRequired(false);

      const linkInput = new TextInputBuilder()
        .setCustomId('linkUrl')
        .setLabel('Tautan Pengumpulan (URL)')
        .setStyle(TextInputStyle.Short)
        .setValue(task.linkUrl || '')
        .setPlaceholder('https://classroom.google.com/...')
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(dueInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(priorityInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(linkInput)
      );

      await interaction.showModal(modal);
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

  // 📝 2. Tangani Form Pop-Up (Discord Modal Submit)
  if (interaction.isModalSubmit()) {
    if (interaction.customId.startsWith('modal_edit_task_')) {
      const taskId = interaction.customId.replace('modal_edit_task_', '');
      await interaction.deferReply({ ephemeral: true });

      const newTitle = interaction.fields.getTextInputValue('title');
      const newDueText = interaction.fields.getTextInputValue('due')?.trim();
      const newPriorityText = interaction.fields.getTextInputValue('priority')?.toUpperCase().trim() || 'MEDIUM';
      const newLink = interaction.fields.getTextInputValue('linkUrl')?.trim() || null;

      let dueAtDate: Date | null = null;
      if (newDueText && newDueText.length > 0) {
        const parsedAI = await AIService.extractTask(`Tugas ${newDueText}`);
        if (parsedAI?.dueAt) {
          dueAtDate = new Date(parsedAI.dueAt);
        } else {
          const directD = new Date(newDueText);
          if (!isNaN(directD.getTime())) dueAtDate = directD;
        }
      }

      const priorityEnum = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(newPriorityText)
        ? (newPriorityText as any)
        : 'MEDIUM';

      const updated = await prisma.task.update({
        where: { id: taskId },
        data: {
          title: newTitle,
          dueAt: dueAtDate,
          priority: priorityEnum,
          linkUrl: newLink
        }
      });

      // Perbarui Live Radar Dashboard secara realtime
      if (updated.guildId) {
        const dbG = await prisma.guild.findUnique({ where: { id: updated.guildId } });
        if (dbG) await GuildService.updateRadarDashboard(dbG.discordGuildId, client);
      } else if (interaction.guild) {
        await GuildService.updateRadarDashboard(interaction.guild);
      }

      const dlStr = updated.dueAt 
        ? `<t:${Math.floor(updated.dueAt.getTime() / 1000)}:F>` 
        : 'Tanpa deadline';

      await interaction.editReply(
        `✅ **Task Berhasil Diperbarui!**\n\n` +
        `📌 **Judul:** ${updated.title}\n` +
        `⏰ **Deadline:** ${dlStr}\n` +
        `🔥 **Prioritas:** ${updated.priority}` +
        (updated.linkUrl ? `\n🔗 **Link:** [Klik di sini](${updated.linkUrl})` : '')
      );
      return;
    }
  }

  // 🔽 3. Tangani Dropdown Filter (StringSelectMenu)
  if (interaction.isStringSelectMenu()) {
    if (interaction.customId.startsWith('tasks_filter_')) {
      const selected = interaction.values[0];
      await interaction.deferUpdate();

      const discordId = interaction.user.id;
      let whereClause: any = {
        OR: [
          { user: { discordId } },
          { assignedUserIds: { has: discordId } }
        ],
        deletedAt: null
      };

      if (selected === 'urgent') {
        whereClause.status = { in: ['TODO', 'IN_PROGRESS'] };
        whereClause.priority = { in: ['HIGH', 'URGENT'] };
      } else if (selected === 'group') {
        whereClause.status = { in: ['TODO', 'IN_PROGRESS'] };
        whereClause.taskType = 'GROUP';
      } else if (selected === 'individual') {
        whereClause.status = { in: ['TODO', 'IN_PROGRESS'] };
        whereClause.taskType = 'INDIVIDUAL';
      } else if (selected === 'done') {
        whereClause.status = 'DONE';
      } else {
        whereClause.status = { in: ['TODO', 'IN_PROGRESS'] };
      }

      const tasks = await prisma.task.findMany({
        where: whereClause,
        orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }],
        take: 10
      });

      const priorityEmoji: Record<string, string> = { URGENT: '🚨', HIGH: '🔥', MEDIUM: '⚡', LOW: '🌱' };
      const filterTitles: Record<string, string> = {
        all: '📋 Semua Tugas Aktif Kamu',
        urgent: '🔥 Tugas Mendesak & Prioritas Tinggi',
        group: '👥 Tugas Kelompok Kamu',
        individual: '👤 Tugas Individu Kamu',
        done: '✅ Riwayat Tugas yang Selesai'
      };

      if (tasks.length === 0) {
        const emptyEmbed = new EmbedBuilder()
          .setTitle(filterTitles[selected] || '📋 Daftar Tugas')
          .setColor('#5865F2')
          .setDescription('Tidak ada tugas pada filter ini. Santai sejenak! ☕');
        await interaction.editReply({ embeds: [emptyEmbed] });
        return;
      }

      const embed = new EmbedBuilder()
        .setTitle(filterTitles[selected] || '📋 Daftar Tugas')
        .setColor(selected === 'done' ? '#00FF7F' : '#5865F2')
        .setDescription(
          tasks.map((t, idx) => {
            const dl = t.dueAt ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R>` : 'Tanpa deadline';
            const linkText = t.linkUrl ? ` | 🔗 [Link](${t.linkUrl})` : '';
            const typeBadge = t.taskType === 'GROUP' ? '👥 [Kelompok]' : '👤 [Individu]';
            const statusPrefix = t.status === 'DONE' ? '✅ ~~' : `**${idx + 1}.** `;
            const statusSuffix = t.status === 'DONE' ? '~~' : '';
            return `${statusPrefix}${typeBadge} ${t.title}${statusSuffix}\n${priorityEmoji[t.priority] || '⚡'} Prioritas: **${t.priority}** | ⏰ Deadline: ${dl}${linkText}`;
          }).join('\n\n')
        )
        .setFooter({ text: 'Gunakan dropdown di bawah untuk mengganti filter' });

      const actionRows: any[] = [];
      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`tasks_filter_${interaction.user.id}`)
        .setPlaceholder('🔍 Filter Tampilan Tugas...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Semua Tugas Aktif').setValue('all').setEmoji('📌').setDefault(selected === 'all'),
          new StringSelectMenuOptionBuilder().setLabel('Prioritas Tinggi / Mendesak').setValue('urgent').setEmoji('🔥').setDefault(selected === 'urgent'),
          new StringSelectMenuOptionBuilder().setLabel('Tugas Kelompok Saja').setValue('group').setEmoji('👥').setDefault(selected === 'group'),
          new StringSelectMenuOptionBuilder().setLabel('Tugas Individu Saja').setValue('individual').setEmoji('👤').setDefault(selected === 'individual'),
          new StringSelectMenuOptionBuilder().setLabel('Riwayat Tugas Selesai').setValue('done').setEmoji('✅').setDefault(selected === 'done')
        );

      actionRows.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu));

      if (selected !== 'done') {
        const doneButtons = tasks.slice(0, 5).map((t, i) =>
          new ButtonBuilder()
            .setCustomId(`task_done_${t.id}`)
            .setLabel(`Selesai #${i + 1}`)
            .setStyle(ButtonStyle.Success)
        );
        if (doneButtons.length > 0) {
          actionRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(doneButtons));
        }
      }

      await interaction.editReply({ embeds: [embed], components: actionRows });
      return;
    }
  }

  // 🖱️ 4. Tangani Context Menu Command (Klik Kanan Pesan -> Add to TaskFlow)
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
          tasks.length === 0
            ? '🎉 Yeay! Kamu tidak memiliki tugas aktif saat ini. Waktunya santai!'
            : tasks.map((t, idx) => {
                const dl = t.dueAt ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R>` : 'Tanpa deadline';
                const linkText = t.linkUrl ? ` | 🔗 [Link](${t.linkUrl})` : '';
                const typeBadge = t.taskType === 'GROUP' ? '👥 [Kelompok]' : '👤 [Individu]';
                return `**${idx + 1}. ${typeBadge} ${t.title}**\n${priorityEmoji[t.priority] || '⚡'} Prioritas: **${t.priority}** | ⏰ Deadline: ${dl}${linkText}`;
              }).join('\n\n')
        )
        .setFooter({ text: 'Gunakan dropdown di bawah untuk memfilter tampilan tugas' });

      const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`tasks_filter_${interaction.user.id}`)
        .setPlaceholder('🔍 Filter Tampilan Tugas...')
        .addOptions(
          new StringSelectMenuOptionBuilder().setLabel('Semua Tugas Aktif').setValue('all').setEmoji('📌').setDefault(true),
          new StringSelectMenuOptionBuilder().setLabel('Prioritas Tinggi / Mendesak').setValue('urgent').setEmoji('🔥'),
          new StringSelectMenuOptionBuilder().setLabel('Tugas Kelompok Saja').setValue('group').setEmoji('👥'),
          new StringSelectMenuOptionBuilder().setLabel('Tugas Individu Saja').setValue('individual').setEmoji('👤'),
          new StringSelectMenuOptionBuilder().setLabel('Riwayat Tugas Selesai').setValue('done').setEmoji('✅')
        );

      const rows: any[] = [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu)
      ];

      const buttons = tasks.slice(0, 5).map((t, i) =>
        new ButtonBuilder()
          .setCustomId(`task_done_${t.id}`)
          .setLabel(`Selesai #${i + 1}`)
          .setStyle(ButtonStyle.Success)
      );

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

  if (interaction.commandName === 'week') {
    await interaction.deferReply({ ephemeral: true });

    try {
      const now = new Date();
      const startOfToday = new Date();
      startOfToday.setHours(0, 0, 0, 0);

      const sevenDaysLater = new Date(startOfToday.getTime() + 7 * 24 * 60 * 60 * 1000);
      sevenDaysLater.setHours(23, 59, 59, 999);

      const tasks = await prisma.task.findMany({
        where: {
          OR: [
            { user: { discordId: interaction.user.id } },
            { assignedUserIds: { has: interaction.user.id } },
            ...(interaction.guildId ? [{ guild: { discordGuildId: interaction.guildId } }] : [])
          ],
          status: { in: ['TODO', 'IN_PROGRESS'] },
          deletedAt: null,
          dueAt: { lte: sevenDaysLater }
        },
        orderBy: { dueAt: 'asc' }
      });

      if (tasks.length === 0) {
        await interaction.editReply('🎉 **Tidak ada deadline tugas dalam 7 hari ke depan!** Jadwalmu minggu ini sangat santai.');
        return;
      }

      const overdueTasks: typeof tasks = [];
      const todayTasks: typeof tasks = [];
      const tomorrowTasks: typeof tasks = [];
      const upcomingTasks: typeof tasks = [];

      const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      const endOfTomorrow = new Date(endOfToday.getTime() + 24 * 60 * 60 * 1000);

      for (const t of tasks) {
        if (!t.dueAt) continue;
        if (t.dueAt < now) {
          overdueTasks.push(t);
        } else if (t.dueAt < endOfToday) {
          todayTasks.push(t);
        } else if (t.dueAt < endOfTomorrow) {
          tomorrowTasks.push(t);
        } else {
          upcomingTasks.push(t);
        }
      }

      const priorityEmoji: Record<string, string> = { URGENT: '🚨', HIGH: '🔥', MEDIUM: '⚡', LOW: '🌱' };
      const formatTask = (t: typeof tasks[0]) => {
        const typeBadge = t.taskType === 'GROUP' ? '👥' : '👤';
        const link = t.linkUrl ? ` [🔗](${t.linkUrl})` : '';
        const dl = t.dueAt ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R>` : '';
        return `• ${priorityEmoji[t.priority] || '⚡'} ${typeBadge} **${t.title}** (${dl})${link}`;
      };

      let desc = `🗓️ **Agenda Tugas 7 Hari ke Depan**\nTotal: **${tasks.length} Tugas Terjadwal**\n\n`;

      if (overdueTasks.length > 0) {
        desc += `⚠️ **LEWAT DEADLINE (${overdueTasks.length})**\n${overdueTasks.map(formatTask).join('\n')}\n\n`;
      }
      if (todayTasks.length > 0) {
        desc += `🔥 **HARI INI (${todayTasks.length})**\n${todayTasks.map(formatTask).join('\n')}\n\n`;
      }
      if (tomorrowTasks.length > 0) {
        desc += `⚡ **BESOK (${tomorrowTasks.length})**\n${tomorrowTasks.map(formatTask).join('\n')}\n\n`;
      }
      if (upcomingTasks.length > 0) {
        desc += `📅 **SISA MINGGU INI (${upcomingTasks.length})**\n${upcomingTasks.map(formatTask).join('\n')}\n\n`;
      }

      const embed = new EmbedBuilder()
        .setTitle('🗓️ Weekly Task Horizon (7 Hari)')
        .setDescription(desc)
        .setColor('#5865F2')
        .setFooter({ text: 'TaskFlow OS • Pantau beban mingguanmu agar tidak menumpuk!' })
        .setTimestamp();

      const buttons = tasks.slice(0, 5).map((t, idx) =>
        new ButtonBuilder()
          .setCustomId(`task_done_${t.id}`)
          .setLabel(`Selesai #${idx + 1}`)
          .setStyle(ButtonStyle.Success)
      );

      const comp = buttons.length > 0
        ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)]
        : [];

      await interaction.editReply({ embeds: [embed], components: comp });
    } catch (err) {
      logger.error({ err }, 'Gagal mengambil data /week');
      await interaction.editReply('❌ Gagal memuat agenda mingguan.');
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

