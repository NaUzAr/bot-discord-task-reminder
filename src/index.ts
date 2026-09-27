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
import { reminderQueue } from './workers/queue';

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

  // 🔁 Recurring Task Scheduler: Cek tugas berulang setiap 15 menit
  setInterval(async () => {
    try {
      const { createdTasks } = await TaskService.processRecurringTasks();
      for (const ct of createdTasks) {
        // Kirim notifikasi DM ke user bahwa tugas baru auto-generated
        try {
          const discordUser = await client.users.fetch(ct.discordId).catch(() => null);
          if (discordUser) {
            const embed = new EmbedBuilder()
              .setTitle('🔁 Tugas Berulang Otomatis Dibuat!')
              .setDescription(
                `📌 **${ct.title}**\n\n` +
                `Tugas ini otomatis dibuat dari jadwal berulangmu. Cek detail dan deadline-nya di server ya!`
              )
              .setColor('#9B59B6')
              .setFooter({ text: 'TaskFlow OS • Recurring Task Auto-Generator' })
              .setTimestamp();
            await discordUser.send({ embeds: [embed] }).catch(() => null);
          }
        } catch { }

        // Update radar dashboard jika ada guild
        if (ct.guildDiscordId) {
          await GuildService.updateRadarDashboard(ct.guildDiscordId, client);
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error pada recurring task scheduler');
    }
  }, 15 * 60 * 1000); // Setiap 15 menit

  // Jalankan sekali saat boot untuk proses recurring yang tertunda
  TaskService.processRecurringTasks().catch(() => null);
});

// 📥 AUTO-LISTEN: Mendengarkan pesan obrolan di channel inbox-tugas secara otomatis
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  // 🤖 AI Natural Language Query via Mention (@TaskFlow <pertanyaan>)
  if (client.user && message.mentions.has(client.user)) {
    const cleanQuery = message.content.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
    if (cleanQuery.length >= 3) {
      try {
        await (message.channel as TextChannel).sendTyping().catch(() => null);
        const { tasks, userStats } = await TaskService.getTasksForAIQuery(
          message.author.id,
          message.guild.id
        );
        const answer = await AIService.answerTaskQuery(cleanQuery, tasks, userStats);

        const replyEmbed = new EmbedBuilder()
          .setTitle('🤖 TaskFlow AI Assistant')
          .setDescription(answer)
          .setColor('#5865F2')
          .setFooter({ text: 'TaskFlow OS • Tanya tugas kapan saja dengan mention @bot atau /ask' })
          .setTimestamp();

        const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId('room_focus_25')
            .setLabel('🎯 Mulai Fokus 25m')
            .setStyle(ButtonStyle.Success),
          new ButtonBuilder()
            .setCustomId('room_focus_50')
            .setLabel('🔥 Deep Work 50m')
            .setStyle(ButtonStyle.Primary)
        );

        await message.reply({ embeds: [replyEmbed], components: [actionRow] });
        return;
      } catch (askErr) {
        logger.error({ askErr }, 'Gagal merespon mention AI query');
        await message.reply('❌ Maaf, aku sedang mengalami kendala saat membaca datamu. Coba gunakan perintah `/ask` ya!');
        return;
      }
    }
  }

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
        } catch { }
      }, 8 * 1000);
      return;
    }

    // 📚 Smart Thread Grouping: Cek apakah tugas berkaitan dengan Mata Kuliah tertentu
    let thread = message.thread;
    let isReusedThread = false;

    if (!thread) {
      // 1. Jika terdeteksi nama mata kuliah, cari apakah sudah ada thread aktif yang SESUAI TIPENYA (Kelompok vs Individu)
      if (extracted.courseName && message.channel.isTextBased() && 'threads' in message.channel) {
        try {
          const activeThreads = await (message.channel as TextChannel).threads.fetchActive().catch(() => null);
          if (activeThreads) {
            const courseLower = extracted.courseName.toLowerCase();
            const existingCourseThread = activeThreads.threads.find(th => {
              const thLower = th.name.toLowerCase();
              const matchesCourse = thLower.includes(courseLower);
              if (!matchesCourse) return false;

              if (isGroup) {
                // Untuk tugas kelompok: HANYA gabung ke thread yang memang ditandai untuk KELOMPOK
                return thLower.includes('kelompok') || thLower.includes('👥');
              } else {
                // Untuk tugas individu: HANYA gabung ke thread individu dan BUKAN thread kelompok
                const isGroupThread = thLower.includes('kelompok') || thLower.includes('👥');
                return !isGroupThread;
              }
            });

            if (existingCourseThread && !existingCourseThread.archived) {
              thread = existingCourseThread;
              isReusedThread = true;
              logger.info(`Reusing existing ${isGroup ? 'GROUP' : 'INDIVIDUAL'} course thread: ${thread.name} (${thread.id}) for course: ${extracted.courseName}`);
            }
          }
        } catch (fetchThreadErr) {
          logger.warn({ fetchThreadErr }, 'Gagal fetch active threads for course');
        }
      }

      // 2. Jika belum ada thread untuk tipe & mata kuliah ini, buat thread baru dengan nama dan tipe yang terpisah jelas
      if (!thread) {
        try {
          const threadPrefix = isGroup ? '👥・[Kelompok]' : '📚・[Individu]';
          const threadName = extracted.courseName
            ? `${threadPrefix} ${extracted.courseName}`
            : `${threadPrefix} ${extracted.title.slice(0, 75)}`;

          thread = await message.startThread({
            name: threadName,
            autoArchiveDuration: 1440
          });
        } catch (threadErr) {
          logger.warn({ threadErr }, 'Failed to start thread on message');
        }
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

    if (task.description) {
      embed.addFields({
        name: '📝 Spesifikasi & Format Tugas',
        value: task.description.length > 1024 ? task.description.slice(0, 1020) + '...' : task.description,
        inline: false
      });
    }

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

    // Jika AI mendeteksi sub-tugas/format checklist otomatis (misal dari gambar format makalah/outline), langsung kirim checklist interaktif!
    if (extracted.subtasks && extracted.subtasks.length > 0) {
      const createdSubtasks = await TaskService.getSubtasks(task.id);
      if (createdSubtasks.length > 0) {
        const { embed: subtaskEmbed, components: subtaskComponents } = renderSubtasksChecklist(task, createdSubtasks);
        await targetChannel.send({ embeds: [subtaskEmbed], components: subtaskComponents });
      }
    }

    if (thread) {
      const groupNote = isGroup ? ` (👥 Anggota: ${mentionedUsers.map(u => `<@${u.id}>`).join(', ')})` : '';
      const typeLabel = isGroup ? 'Kelompok' : 'Individu';
      const courseNote = extracted.courseName ? ` untuk mata kuliah **${extracted.courseName}**` : '';
      const replyContent = isReusedThread
        ? `✅ **Tugas Baru Dicatat!** Tugas ${typeLabel}${courseNote} digabungkan ke thread ${typeLabel}: <#${thread.id}>.${groupNote}\n*(Pesan input & notifikasi ini otomatis terhapus dalam 10 detik agar inbox tetap bersih)*`
        : `✅ **Task ${typeLabel} Dicatat!** Buka thread <#${thread.id}> untuk rincian, AI breakdown, dan aksi tugas.${groupNote}\n*(Pesan input & notifikasi ini otomatis terhapus dalam 10 detik agar inbox tetap bersih)*`;

      const replyMsg = await message.reply({
        content: replyContent
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

  // Dukung hingga 15 tombol interaktif (dibagi rapi per 5 tombol per ActionRow)
  const compRows: ActionRowBuilder<ButtonBuilder>[] = [];
  const maxButtons = Math.min(subtasks.length, 15);
  for (let i = 0; i < maxButtons; i += 5) {
    const chunk = subtasks.slice(i, i + 5);
    const rowButtons = chunk.map((s, relIdx) => {
      const idx = i + relIdx;
      return new ButtonBuilder()
        .setCustomId(`subtask_toggle_${s.id}`)
        .setLabel(`#${idx + 1} ${s.status === 'DONE' ? '↩️ Batal' : '✔️ Centang'}`)
        .setStyle(s.status === 'DONE' ? ButtonStyle.Secondary : ButtonStyle.Primary);
    });
    compRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(rowButtons));
  }

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

      // Cek apakah masih ada tugas aktif lain di thread ini!
      let remainingTasks: any[] = [];
      let threadObj: any = null;
      if (isInsideThread) {
        threadObj = interaction.channel;
      } else if (updated.sourceChannelId) {
        const ch = await client.channels.fetch(updated.sourceChannelId).catch(() => null);
        if (ch?.isThread()) threadObj = ch;
      }

      if (threadObj) {
        remainingTasks = await prisma.task.findMany({
          where: {
            sourceChannelId: threadObj.id,
            status: { in: ['TODO', 'IN_PROGRESS'] },
            id: { not: updated.id },
            deletedAt: null
          },
          orderBy: [{ dueAt: 'asc' }, { priority: 'desc' }]
        });
      }

      const threadNote = remainingTasks.length > 0
        ? `\n\n📌 *Masih ada ${remainingTasks.length} tugas aktif lagi di thread ini (daftar tugas tersisa ditampilkan di bawah).*`
        : (isInsideThread ? '\n\n🗑️ *Seluruh tugas di thread ini telah tuntas. Thread akan otomatis dihapus permanen dalam 3 detik...*' : '');

      const doneEmbed = new EmbedBuilder()
        .setTitle('✅ Task Telah Selesai!')
        .setDescription(
          `~~${updated.title}~~\n\n🎉 Kerja bagus! Tugas ini telah ditandai selesai (+50 XP) dan reminder dibatalkan.` +
          threadNote
        )
        .setColor('#00FF7F')
        .setTimestamp();

      await interaction.editReply({ embeds: [doneEmbed], components: [] });

      // Proses hapus thread & pesan asli chat di inbox jika seluruh tugas di thread selesai
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

          // 1. Bersihkan pesan chat & notifikasi bot di inbox-tugas jika tidak ada tugas tersisa
          if (parentChannelId && remainingTasks.length === 0) {
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

          // 2. Beri pesan penutup di thread lalu hapus thread jika semua tugas selesai
          if (threadToDelete) {
            if (remainingTasks.length > 0) {
              const priorityEmoji: Record<string, string> = { URGENT: '🚨', HIGH: '🔥', MEDIUM: '⚡', LOW: '🌱' };

              const remainingListText = remainingTasks.map((t, idx) => {
                const dl = t.dueAt
                  ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R> (<t:${Math.floor(t.dueAt.getTime() / 1000)}:t>)`
                  : 'Tanpa batas waktu';
                const typeBadge = t.taskType === 'GROUP' ? '👥' : '👤';
                const link = t.linkUrl ? ` | 🔗 [Link](${t.linkUrl})` : '';
                return `**${idx + 1}.** ${typeBadge} **${t.title}**\n> ⏰ Deadline: ${dl}\n> 🔥 Prioritas: ${priorityEmoji[t.priority] || '⚡'} **${t.priority}**${link}`;
              }).join('\n\n');

              const keepEmbed = new EmbedBuilder()
                .setTitle('🎉 Tugas Selesai!')
                .setDescription(
                  `Tugas **${updated.title}** telah diselesaikan (+50 XP)!\n\n` +
                  `📋 **TUGAS TERSISA DI THREAD INI (${remainingTasks.length} Tugas):**\n\n` +
                  remainingListText +
                  `\n\n*Thread tetap dibuka sampai seluruh tugas di atas tuntas. Semangat!* 🚀`
                )
                .setColor('#00FF7F')
                .setFooter({ text: 'TaskFlow OS • Course Thread Tracker' })
                .setTimestamp();

              // Tambahkan tombol Selesai cepat untuk tugas yang tersisa (maksimal 4 tombol + 1 tombol fokus)
              const actionRows: ActionRowBuilder<ButtonBuilder>[] = [];
              const taskButtons = remainingTasks.slice(0, 4).map((t, i) =>
                new ButtonBuilder()
                  .setCustomId(`task_done_${t.id}`)
                  .setLabel(`Selesai #${i + 1}`)
                  .setStyle(ButtonStyle.Success)
              );

              taskButtons.push(
                new ButtonBuilder()
                  .setCustomId('room_focus_25')
                  .setLabel('🎯 Fokus 25m')
                  .setStyle(ButtonStyle.Primary)
              );

              actionRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(taskButtons));

              await threadToDelete.send({ embeds: [keepEmbed], components: actionRows }).catch(() => null);
              logger.info(`Thread ${threadToDelete.id} dipertahankan dengan daftar ${remainingTasks.length} tugas aktif.`);
            } else {
              if (!isInsideThread) {
                const closingEmbed = new EmbedBuilder()
                  .setTitle('🗑️ Seluruh Tugas di Thread Selesai')
                  .setDescription('🎉 Luar biasa! Semua tugas di mata kuliah/thread ini telah tuntas (+Bonus 30 XP)! Thread ini akan dihapus permanen dalam 3 detik...')
                  .setColor('#00FF7F');
                await threadToDelete.send({ embeds: [closingEmbed] }).catch(() => null);
              }

              await new Promise((resolve) => setTimeout(resolve, 3000));
              await threadToDelete.delete('Semua tugas di thread telah diselesaikan').catch(() => null);
              logger.info(`Thread ${threadToDelete.id} berhasil dihapus permanen karena semua task telah selesai.`);
            }
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

      const descInput = new TextInputBuilder()
        .setCustomId('description')
        .setLabel('Catatan / Spesifikasi Format')
        .setStyle(TextInputStyle.Paragraph)
        .setValue(task.description || '')
        .setPlaceholder('Format pengerjaan, bab, atau catatan khusus...')
        .setRequired(false);

      modal.addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(titleInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(dueInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(priorityInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(linkInput),
        new ActionRowBuilder<TextInputBuilder>().addComponents(descInput)
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
      const parts = customId.split('_');
      const taskId = customId.startsWith('task_focus_') ? parts[2] : '';
      await interaction.deferReply({ ephemeral: true });

      const session = await TaskService.startFocusSession(taskId, interaction.user.id, duration, interaction.guildId || undefined);

      const endTime = new Date(Date.now() + duration * 60 * 1000);
      const endTimestamp = Math.floor(endTime.getTime() / 1000);

      // 1. Berikan role @In Focus ke user jika di dalam Guild
      if (interaction.guild && interaction.member) {
        try {
          const focusRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase().includes('in focus'));
          if (focusRole && 'roles' in interaction.member) {
            await (interaction.member as any).roles.add(focusRole).catch(() => null);
          }
        } catch (rErr) {
          logger.warn({ rErr }, 'Gagal memberikan role In Focus');
        }
      }

      // 2. Kirim pengumuman publik di channel 🎯・fokus-room jika ada
      if (interaction.guild) {
        try {
          const dbG = await prisma.guild.findUnique({ where: { discordGuildId: interaction.guild.id } });
          const focusChanId = dbG?.focusChannelId;
          if (focusChanId) {
            const fChannel = await interaction.guild.channels.fetch(focusChanId).catch(() => null);
            if (fChannel && 'send' in fChannel) {
              const publicFocusEmbed = new EmbedBuilder()
                .setTitle('🧘 Sesi Deep Work Dimulai!')
                .setDescription(
                  `👤 <@${interaction.user.id}> telah mengaktifkan **Sesi Fokus ${duration} Menit**!\n\n` +
                  `🛡️ **Status:** \`@In Focus\` (Do Not Disturb Aktif)\n` +
                  `⏰ **Berakhir pada:** <t:${endTimestamp}:t> (<t:${endTimestamp}:R>)\n\n` +
                  `*Mohon tidak mendistraksi selama sesi berlangsung. Semangat produktif! ☕*`
                )
                .setColor('#9B59B6')
                .setTimestamp();
              await (fChannel as any).send({ embeds: [publicFocusEmbed] });
            }
          }
        } catch (pubErr) {
          logger.warn({ pubErr }, 'Gagal mengirim pengumuman publik fokus');
        }
      }

      // 3. Tombol Kontrol Sesi Aktif
      const controlButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId(`focus_stop_${session.id}`)
          .setLabel('⏹️ Hentikan Sesi Lebih Awal')
          .setStyle(ButtonStyle.Danger),
        ...(taskId ? [
          new ButtonBuilder()
            .setCustomId(`task_done_${taskId}`)
            .setLabel('✅ Tugas Selesai Duluan')
            .setStyle(ButtonStyle.Success)
        ] : [])
      );

      const focusEmbed = new EmbedBuilder()
        .setTitle('🍅 Sesi Pomodoro Dimulai!')
        .setDescription(
          `⏱️ **Waktu Fokus:** **${duration} menit** (+${duration >= 50 ? 50 : 25} XP)\n` +
          `🛡️ **Status Server:** Role \`@In Focus\` telah diaktifkan untukmu!\n` +
          `⏰ **Selesai pada:** <t:${endTimestamp}:t> (<t:${endTimestamp}:R>)\n\n` +
          '💡 *Jauhkan HP, tutup tab media sosial, dan fokus bekerja. Bot akan mengirim notifikasi saat waktu istirahat tiba!* ☕'
        )
        .setColor('#00FF7F')
        .setTimestamp();

      await interaction.editReply({ embeds: [focusEmbed], components: [controlButtons] });

      // Kirim juga kartu kontrol ini ke DM pengguna agar mudah diakses
      try {
        await interaction.user.send({ embeds: [focusEmbed], components: [controlButtons] });
      } catch { }
      return;
    }

    // Tombol: Hentikan Sesi Fokus Lebih Awal
    if (customId.startsWith('focus_stop_')) {
      const sessionId = customId.replace('focus_stop_', '');
      await interaction.deferUpdate();

      try {
        const session = await prisma.focusSession.findUnique({ where: { id: sessionId } });
        if (session && !session.endedAt) {
          await prisma.focusSession.update({
            where: { id: sessionId },
            data: { endedAt: new Date() }
          });
        }

        // Batalkan BullMQ job focus-end
        const job = await reminderQueue.getJob(`focus_${sessionId}`);
        if (job) await job.remove();

        // Lepas role @In Focus di guild
        if (interaction.guild && interaction.member) {
          const focusRole = interaction.guild.roles.cache.find(r => r.name.toLowerCase().includes('in focus'));
          if (focusRole && 'roles' in interaction.member) {
            await (interaction.member as any).roles.remove(focusRole).catch(() => null);
          }
        }

        const stopEmbed = new EmbedBuilder()
          .setTitle('⏹️ Sesi Fokus Dihentikan')
          .setDescription('Sesi fokus telah dihentikan lebih awal. Tidak apa-apa, kamu bisa mulai lagi kapan saja saat siap! ☕')
          .setColor('#95A5A6')
          .setTimestamp();

        await interaction.editReply({ embeds: [stopEmbed], components: [] });
      } catch (err) {
        logger.warn({ err }, 'Gagal menghentikan sesi fokus');
      }
      return;
    }

    // Tombol: Mulai Rehat 5 Menit (Pomodoro Break)
    if (customId.startsWith('focus_break_')) {
      const parts = customId.split('_');
      const minutes = parseInt(parts[2] || '5', 10);
      const taskId = parts[3] || '';
      await interaction.deferReply({ ephemeral: true });

      const user = await TaskService.getOrCreateUser(interaction.user.id, interaction.user.username);
      const delay = minutes * 60 * 1000;
      const breakEndTime = new Date(Date.now() + delay);
      const breakEndTimestamp = Math.floor(breakEndTime.getTime() / 1000);

      await reminderQueue.add('break-end', {
        userId: user.id,
        discordId: interaction.user.id,
        taskId
      }, {
        delay,
        jobId: `break_${user.id}_${Date.now()}`
      });

      const breakEmbed = new EmbedBuilder()
        .setTitle('☕ Waktu Istirahat Dimulai!')
        .setDescription(
          `⏱️ **Durasi Rehat:** **${minutes} menit**\n` +
          `⏰ **Selesai pada:** <t:${breakEndTimestamp}:t> (<t:${breakEndTimestamp}:R>)\n\n` +
          'Regangkan badanmu 🧘, minum segelas air putih 💧, dan jauhi layar sejenak. Bot akan mengirim notifikasi saat waktu istirahat habis! 🎵'
        )
        .setColor('#F1C40F')
        .setTimestamp();

      await interaction.editReply({ embeds: [breakEmbed] });
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
      const newDesc = interaction.fields.getTextInputValue('description')?.trim() || null;

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

      let normalizedLink = newLink;
      if (normalizedLink && !normalizedLink.startsWith('http://') && !normalizedLink.startsWith('https://')) {
        normalizedLink = `https://${normalizedLink}`;
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
          linkUrl: normalizedLink,
          description: newDesc
        }
      });

      // Jadwalkan ulang reminder jika deadline diubah
      if (updated.dueAt) {
        await TaskService.scheduleTaskReminders(updated);
      }

      // Perbarui Live Radar Dashboard secara realtime
      if (updated.guildId) {
        const dbG = await prisma.guild.findUnique({ where: { id: updated.guildId } });
        if (dbG) await GuildService.updateRadarDashboard(dbG.discordGuildId, client);
      } else if (interaction.guild) {
        await GuildService.updateRadarDashboard(interaction.guild);
      }

      // 🔄 Perbarui Tampilan Pesan Kartu Tugas Utama di Thread / Channel Secara Realtime!
      if (interaction.message) {
        try {
          const isGroup = updated.taskType === 'GROUP';
          const embedColor = isGroup ? '#3498DB' : '#00E5FF';
          const embedTitle = isGroup
            ? '👥 Task Kelompok Terdeteksi dari Inbox!'
            : '👤 Task Individu Terdeteksi dari Inbox!';

          const memberListText = isGroup
            ? updated.assignedUserIds.map(id => `<@${id}>`).join(', ')
            : `<@${updated.userId}>`;

          const deadlineFormatted = updated.dueAt
            ? `<t:${Math.floor(updated.dueAt.getTime() / 1000)}:F> (<t:${Math.floor(updated.dueAt.getTime() / 1000)}:R>)`
            : 'Tidak ada batas waktu';

          const cardEmbed = new EmbedBuilder()
            .setTitle(embedTitle)
            .setDescription(
              `### **${updated.title}**\n\n` +
              `🏷️ **Tipe:** **${isGroup ? '👥 Tugas Kelompok' : '👤 Tugas Individu'}**\n` +
              `👥 **Anggota:** ${memberListText}\n` +
              `⏰ **Deadline:** ${deadlineFormatted}\n` +
              `🔥 **Prioritas:** ${updated.priority}`
            )
            .setColor(embedColor)
            .setFooter({ text: isGroup ? 'Tugas Kelompok • Anggota tim otomatis diundang ke thread & diingatkan!' : 'Klik "Edit" untuk ubah rincian, atau "AI Breakdown" untuk memecah tugas!' })
            .setTimestamp();

          if (updated.description) {
            cardEmbed.addFields({
              name: '📝 Spesifikasi & Format Tugas',
              value: updated.description.length > 1024 ? updated.description.slice(0, 1020) + '...' : updated.description,
              inline: false
            });
          }

          if (updated.linkUrl) {
            cardEmbed.addFields({
              name: '🔗 Tempat Pengumpulan',
              value: `[Klik untuk Membuka Tautan Pengumpulan](${updated.linkUrl})`,
              inline: false
            });
          }

          const primaryButtons = [
            new ButtonBuilder()
              .setCustomId(`task_done_${updated.id}`)
              .setLabel('Selesai')
              .setStyle(ButtonStyle.Success)
              .setEmoji('✅'),
            new ButtonBuilder()
              .setCustomId(`task_edit_${updated.id}`)
              .setLabel('Edit')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('✏️'),
            new ButtonBuilder()
              .setCustomId(`task_breakdown_${updated.id}`)
              .setLabel('AI Breakdown')
              .setStyle(ButtonStyle.Primary)
              .setEmoji('🧩'),
            new ButtonBuilder()
              .setCustomId(`task_snooze_${updated.id}_30`)
              .setLabel('Tunda 30m')
              .setStyle(ButtonStyle.Secondary)
              .setEmoji('💤')
          ];

          const linkButtons = [];
          if (updated.dueAt) {
            const gcalUrl = generateGoogleCalendarUrl(
              updated.title,
              updated.dueAt,
              updated.linkUrl,
              updated.description
            );
            linkButtons.push(
              new ButtonBuilder()
                .setLabel('Google Calendar')
                .setStyle(ButtonStyle.Link)
                .setURL(gcalUrl)
                .setEmoji('📅')
            );
          }

          if (updated.linkUrl) {
            try {
              new URL(updated.linkUrl);
              linkButtons.push(
                new ButtonBuilder()
                  .setLabel('Buka Link Tugas')
                  .setStyle(ButtonStyle.Link)
                  .setURL(updated.linkUrl)
                  .setEmoji('🔗')
              );
            } catch { }
          }

          const actionRows: ActionRowBuilder<ButtonBuilder>[] = [
            new ActionRowBuilder<ButtonBuilder>().addComponents(primaryButtons)
          ];
          if (linkButtons.length > 0) {
            actionRows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(linkButtons));
          }

          await interaction.message.edit({ embeds: [cardEmbed], components: actionRows });
          logger.info(`Pesan kartu task ${updated.id} berhasil diperbarui di Discord channel/thread!`);
        } catch (editErr) {
          logger.warn({ editErr }, 'Gagal mengedit pesan asli kartu task');
        }
      }

      const dlStr = updated.dueAt
        ? `<t:${Math.floor(updated.dueAt.getTime() / 1000)}:F>`
        : 'Tanpa deadline';

      await interaction.editReply(
        `✅ **Task Berhasil Diperbarui!**\n\n` +
        `📌 **Judul:** ${updated.title}\n` +
        `⏰ **Deadline:** ${dlStr}\n` +
        `🔥 **Prioritas:** ${updated.priority}` +
        (updated.description ? `\n📝 **Catatan:** ${updated.description}` : '') +
        (updated.linkUrl ? `\n🔗 **Link:** [Klik di sini](${updated.linkUrl})` : '') +
        `\n\n*(Notifikasi ini otomatis tertutup dalam 4 detik agar chat tetap bersih...)*`
      );

      // Otomatis hapus pesan ephemeral ini setelah 4 detik agar tampilan chat selalu bersih
      setTimeout(async () => {
        try {
          await interaction.deleteReply().catch(() => null);
        } catch { }
      }, 4000);
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

        if (task.description) {
          embed.addFields({
            name: '📝 Catatan / Spesifikasi',
            value: task.description.length > 1024 ? task.description.slice(0, 1020) + '...' : task.description
          });
        }

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
        `• 🚨 <#${res.radarChannel.id}> (Papan radar deadline - Read Only)\n` +
        `• 🎯 <#${res.focusChannel.id}> (Pomodoro Focus Hub & Status @In Focus)\n` +
        (res.voiceChannel ? `• 🎧 <#${res.voiceChannel.id}> (Study Voice Room)\n\n` : '\n') +
        `*Silakan coba ketik tugas di channel <#${res.inboxChannel.id}> atau aktifkan sesi fokus di <#${res.focusChannel.id}>!*`
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

      if (task.description) {
        embed.addFields({
          name: '📝 Catatan / Spesifikasi',
          value: task.description.length > 1024 ? task.description.slice(0, 1020) + '...' : task.description
        });
      }

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

  // /plan - AI Daily Planner & Time-Blocking
  if (interaction.commandName === 'plan') {
    await interaction.deferReply();
    const timeframe = interaction.options.getString('waktu') || 'Malam ini (3-4 jam)';

    const discordId = interaction.user.id;
    const activeTasks = await prisma.task.findMany({
      where: {
        OR: [
          { user: { discordId } },
          { assignedUserIds: { has: discordId } }
        ],
        status: { in: ['TODO', 'IN_PROGRESS'] },
        deletedAt: null
      },
      orderBy: [
        { dueAt: 'asc' },
        { priority: 'desc' }
      ],
      take: 8
    });

    if (activeTasks.length === 0) {
      const cleanEmbed = new EmbedBuilder()
        .setTitle('🎉 Tidak Ada Tugas yang Menumpuk!')
        .setDescription('Kamu tidak memiliki tugas aktif saat ini. Nikmati waktu luangmu atau santai bersama teman-teman! ☕')
        .setColor('#00FF7F')
        .setTimestamp();
      await interaction.editReply({ embeds: [cleanEmbed] });
      return;
    }

    try {
      const planText = await AIService.generateStudyPlan(activeTasks, timeframe);

      const planEmbed = new EmbedBuilder()
        .setTitle('🧠 AI Daily Planner & Time-Blocking')
        .setDescription(
          `⏱️ **Alokasi Waktu:** \`${timeframe}\`\n` +
          `📋 **Tugas Dianalisis:** ${activeTasks.length} tugas aktif\n\n` +
          planText
        )
        .setColor('#9B59B6')
        .setFooter({ text: 'TaskFlow OS • AI Study Planner • Klik tombol di bawah untuk langsung mulai fokus!' })
        .setTimestamp();

      const planButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('room_focus_25')
          .setLabel('🎯 Mulai Fokus 25m')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('room_focus_50')
          .setLabel('🔥 Deep Work 50m')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.editReply({ embeds: [planEmbed], components: [planButtons] });
    } catch (planErr) {
      logger.error({ planErr }, 'Gagal menyusun AI plan');
      await interaction.editReply('❌ Terjadi kesalahan saat menyusun rencana belajar.');
    }
    return;
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

  // /workload - Deteksi Beban Kerja & Alert Burnout (Phase 5)
  if (interaction.commandName === 'workload') {
    await interaction.deferReply();
    try {
      const stats = await TaskService.getWorkloadStats(interaction.user.id, interaction.guildId || undefined);
      const totalHours = (stats.totalMinutes / 60).toFixed(1);
      const availHours = (stats.availableMinutes / 60).toFixed(1);
      const ratio = Math.round((stats.totalMinutes / stats.availableMinutes) * 100);

      const filled = Math.min(10, Math.round(ratio / 10));
      const gauge = '█'.repeat(filled) + '░'.repeat(10 - filled);

      let statusColor: `#${string}` = '#00FF7F'; // Green
      let statusBadge = '🟢 Ringan / Aman';
      if (stats.status === 'OVERLOAD') {
        statusColor = '#FF0055'; // Red
        statusBadge = '🚨 OVERLOAD! Risiko Burnout Tinggi';
      } else if (stats.status === 'HEAVY') {
        statusColor = '#FFA500'; // Orange
        statusBadge = '⚠️ Cukup Padat / Perlu Cicil';
      } else if (stats.status === 'MODERATE') {
        statusColor = '#F1C40F'; // Yellow
        statusBadge = '⚡ Produktif Seimbang';
      }

      const adviceText = await AIService.generateWorkloadAdvice(
        stats.tasks,
        stats.totalMinutes,
        stats.availableMinutes
      );

      const taskLines = stats.tasks.map((t, i) => {
        const est = t.estimatedMinutes ? `${t.estimatedMinutes}m` : '60m';
        const dl = t.dueAt ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R>` : 'Tanpa deadline';
        return `**${i + 1}.** ${t.title} — ⏱️ \`${est}\` | ⏰ ${dl}`;
      }).join('\n') || 'Tidak ada tugas yang terdaftar untuk periode ini.';

      const embed = new EmbedBuilder()
        .setTitle('⚠️ Deteksi Beban Kerja & Workload Radar')
        .setColor(statusColor)
        .setDescription(
          `### Status Beban: **${statusBadge}**\n\n` +
          `📊 **Indikator Beban Kerja:**\n` +
          `\`[${gauge}]\` **${ratio}%** (${totalHours} Jam / Kapasitas ${availHours} Jam)\n` +
          `📋 **Tugas Terjadwal:** ${stats.tasks.length} Tugas Aktif\n\n` +
          `---\n\n` +
          `📋 **Daftar Beban Tugas Hari Ini & Besok:**\n` +
          taskLines + `\n\n` +
          `---\n\n` +
          `🧠 **Rekomendasi Cerdas AI:**\n` +
          adviceText
        )
        .setFooter({ text: 'TaskFlow OS • Workload Intelligence • Anti-Burnout Protocol' })
        .setTimestamp();

      const actionButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('room_focus_25')
          .setLabel('🎯 Mulai Fokus 25m')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('room_focus_50')
          .setLabel('🔥 Deep Work 50m')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.editReply({ embeds: [embed], components: [actionButtons] });
    } catch (err) {
      logger.error({ err }, 'Gagal menjalankan /workload');
      await interaction.editReply('❌ Terjadi kesalahan saat menganalisis beban kerja.');
    }
  }

  // /review - AI Weekly Productivity Review & Coaching (Phase 5)
  if (interaction.commandName === 'review') {
    await interaction.deferReply();
    try {
      const reviewStats = await TaskService.getWeeklyReviewStats(interaction.user.id);
      if (!reviewStats) {
        await interaction.editReply('Belum ada data aktivitas untuk dievaluasi.');
        return;
      }

      const focusHours = (reviewStats.totalFocusMinutes / 60).toFixed(1);
      const totalEvaluated = reviewStats.completedTasks.length + reviewStats.overdueTasks.length;
      const completionRate = totalEvaluated > 0
        ? Math.round((reviewStats.completedTasks.length / totalEvaluated) * 100)
        : 100;

      let grade = 'A+ 🏆';
      if (completionRate < 60) grade = 'C ⚠️';
      else if (completionRate < 80) grade = 'B 📈';
      else if (completionRate < 95) grade = 'A 🌟';

      const aiReview = await AIService.generateWeeklyReview(
        reviewStats.completedTasks,
        reviewStats.overdueTasks,
        reviewStats.totalFocusMinutes,
        reviewStats.accuracyScore
      );

      const embed = new EmbedBuilder()
        .setTitle(`📊 Weekly Productivity Review: ${reviewStats.user.username}`)
        .setColor('#9B59B6')
        .setDescription(
          `### Skor Produktivitas 7 Hari: **${grade}**\n\n` +
          `• ✅ **Tugas Selesai:** **${reviewStats.completedTasks.length}** Tugas\n` +
          `• ⚠️ **Tugas Overdue / Tertunda:** **${reviewStats.overdueTasks.length}** Tugas\n` +
          `• ⏱️ **Total Jam Fokus Pomodoro:** **${focusHours} Jam** (${reviewStats.totalFocusMinutes} Menit)\n` +
          `• 🎯 **Akurasi Estimasi Waktu:** **${reviewStats.accuracyScore}%**\n` +
          `• 📈 **Completion Rate:** **${completionRate}%**\n\n` +
          `---\n\n` +
          aiReview
        )
        .setFooter({ text: 'TaskFlow OS • AI Weekly Review • Evaluasi kebiasaan belajarmu tiap minggu!' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error({ err }, 'Gagal menjalankan /review');
      await interaction.editReply('❌ Terjadi kesalahan saat menyusun weekly review.');
    }
  }

  // /course - Mode Mata Kuliah & Thread Grouping (Phase 6)
  if (interaction.commandName === 'course') {
    await interaction.deferReply();
    if (!interaction.guild) {
      await interaction.editReply('❌ Command ini hanya bisa dijalankan di dalam Server (Guild).');
      return;
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'list') {
      try {
        const courses = await TaskService.getCoursesWithTasks(interaction.guild.id);
        if (courses.length === 0) {
          const emptyEmbed = new EmbedBuilder()
            .setTitle('📚 Daftar Mata Kuliah Server')
            .setDescription('Belum ada mata kuliah yang terdata. Cukup sebutkan nama mata kuliah saat mencatat tugas di inbox (misal: *"Tugas 1 Kalkulus besok"*), atau upload silabus tugas!')
            .setColor('#5865F2');
          await interaction.editReply({ embeds: [emptyEmbed] });
          return;
        }

        const embed = new EmbedBuilder()
          .setTitle(`📚 Mata Kuliah & Progress Tugas (${interaction.guild.name})`)
          .setColor('#5865F2')
          .setDescription(
            courses.map(c => {
              const percent = c.total > 0 ? Math.round((c.done / c.total) * 100) : 0;
              const filled = Math.round(percent / 10);
              const bar = '█'.repeat(filled) + '░'.repeat(10 - filled);
              return `### 📖 ${c.name}\n` +
                `📊 Progress: \`[${bar}]\` **${percent}%** (${c.done}/${c.total} Selesai)\n` +
                `🔥 Tugas Aktif: **${c.active} Tugas** | Cek: \`/course tasks nama:${c.name}\``;
            }).join('\n\n')
          )
          .setFooter({ text: 'Semua tugas untuk mata kuliah yang sama otomatis berkumpul di 1 thread!' })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        logger.error({ err }, 'Gagal mengambil /course list');
        await interaction.editReply('❌ Gagal mengambil daftar mata kuliah.');
      }
    } else if (sub === 'tasks') {
      const courseName = interaction.options.getString('nama', true);
      try {
        const tasks = await TaskService.getTasksByCourse(interaction.guild.id, courseName);
        if (tasks.length === 0) {
          await interaction.editReply(`❌ Tidak ditemukan tugas untuk mata kuliah **${courseName}**.`);
          return;
        }

        const priorityEmoji: Record<string, string> = { URGENT: '🚨', HIGH: '🔥', MEDIUM: '⚡', LOW: '🌱' };
        const embed = new EmbedBuilder()
          .setTitle(`📚 Tugas Mata Kuliah: ${courseName}`)
          .setColor('#5865F2')
          .setDescription(
            tasks.map((t, idx) => {
              const dl = t.dueAt ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R>` : 'Tanpa deadline';
              const typeBadge = t.taskType === 'GROUP' ? '👥 [Kelompok]' : '👤 [Individu]';
              const isDone = t.status === 'DONE';
              const prefix = isDone ? '✅ ~~' : `**${idx + 1}.** `;
              const suffix = isDone ? '~~' : '';
              return `${prefix}${typeBadge} ${t.title}${suffix}\n${priorityEmoji[t.priority] || '⚡'} Prioritas: **${t.priority}** | ⏰ Deadline: ${dl}`;
            }).join('\n\n')
          )
          .setFooter({ text: `Total: ${tasks.length} Tugas tercatat untuk ${courseName}` })
          .setTimestamp();

        const activeTasks = tasks.filter(t => t.status !== 'DONE');
        const doneButtons = activeTasks.slice(0, 5).map((t, i) =>
          new ButtonBuilder()
            .setCustomId(`task_done_${t.id}`)
            .setLabel(`Selesai #${i + 1}`)
            .setStyle(ButtonStyle.Success)
        );

        const rows = doneButtons.length > 0
          ? [new ActionRowBuilder<ButtonBuilder>().addComponents(doneButtons)]
          : [];

        await interaction.editReply({ embeds: [embed], components: rows });
      } catch (err) {
        logger.error({ err }, 'Gagal mengambil /course tasks');
        await interaction.editReply('❌ Terjadi kesalahan saat mengambil tugas mata kuliah.');
      }
    }
  }

  // /ask - AI Natural Language Task & Deadline Query
  if (interaction.commandName === 'ask') {
    await interaction.deferReply();
    const query = interaction.options.getString('pertanyaan', true);

    try {
      const { tasks, userStats } = await TaskService.getTasksForAIQuery(
        interaction.user.id,
        interaction.guildId || undefined
      );

      const answer = await AIService.answerTaskQuery(query, tasks, userStats);

      const askEmbed = new EmbedBuilder()
        .setTitle('🤖 TaskFlow AI Assistant')
        .setDescription(`> 💬 *"${query}"*\n\n` + answer)
        .setColor('#5865F2')
        .setFooter({ text: 'TaskFlow OS • Tanya apa saja tentang tugas & jadwalmu!' })
        .setTimestamp();

      const actionRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('room_focus_25')
          .setLabel('🎯 Mulai Fokus 25m')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('room_focus_50')
          .setLabel('🔥 Deep Work 50m')
          .setStyle(ButtonStyle.Primary)
      );

      await interaction.editReply({ embeds: [askEmbed], components: [actionRow] });
    } catch (err) {
      logger.error({ err }, 'Gagal mengeksekusi /ask');
      await interaction.editReply('❌ Terjadi kesalahan saat memproses pertanyaanmu ke AI.');
    }
    return;
  }

  // /repeat - Tugas Berulang (Recurring Tasks) — Phase 10
  if (interaction.commandName === 'repeat') {
    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      await interaction.deferReply();
      const input = interaction.options.getString('input', true);

      try {
        const extracted = await AIService.extractRecurringTask(input);
        if (!extracted) {
          await interaction.editReply('❌ AI gagal memahami jadwal berulangmu. Coba contoh: *"Jurnal praktikum fisika setiap Jumat jam 23:59"*');
          return;
        }

        const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
        const patternLabel: Record<string, string> = {
          'DAILY': '📅 Setiap Hari',
          'WEEKLY': '📆 Setiap Minggu',
          'BIWEEKLY': '🗓️ Setiap 2 Minggu'
        };

        const recurring = await TaskService.createRecurringTask({
          discordId: interaction.user.id,
          username: interaction.user.username,
          guildId: interaction.guildId || undefined,
          guildName: interaction.guild?.name,
          title: extracted.title,
          description: extracted.description,
          courseName: extracted.courseName,
          linkUrl: extracted.linkUrl,
          priority: extracted.priority,
          subtasks: extracted.subtasks,
          repeatPattern: extracted.repeatPattern,
          dayOfWeek: extracted.dayOfWeek,
          deadlineHour: extracted.deadlineHour,
          deadlineMinute: extracted.deadlineMinute
        });

        const scheduleText = extracted.repeatPattern === 'DAILY'
          ? `Setiap hari jam ${String(extracted.deadlineHour).padStart(2, '0')}:${String(extracted.deadlineMinute).padStart(2, '0')} WIB`
          : `${patternLabel[extracted.repeatPattern] || extracted.repeatPattern}, ${dayNames[extracted.dayOfWeek ?? 5]} jam ${String(extracted.deadlineHour).padStart(2, '0')}:${String(extracted.deadlineMinute).padStart(2, '0')} WIB`;

        const nextRunText = `<t:${Math.floor(recurring.nextRunAt.getTime() / 1000)}:F> (<t:${Math.floor(recurring.nextRunAt.getTime() / 1000)}:R>)`;

        const embed = new EmbedBuilder()
          .setTitle('🔁 Tugas Berulang Berhasil Dibuat!')
          .setDescription(
            `📌 **Judul:** ${extracted.title}\n` +
            (extracted.courseName ? `📚 **Mata Kuliah:** ${extracted.courseName}\n` : '') +
            `🔄 **Jadwal:** ${scheduleText}\n` +
            `⏰ **Tugas Berikutnya:** ${nextRunText}\n` +
            `🔥 **Prioritas:** ${extracted.priority}\n` +
            (extracted.subtasks.length > 0 ? `📋 **Sub-tugas Template:** ${extracted.subtasks.length} item\n` : '') +
            `\n*Tugas akan otomatis dibuat sesuai jadwal. Kamu akan mendapat DM notifikasi setiap kali tugas baru dibuat.*`
          )
          .setColor('#9B59B6')
          .setFooter({ text: `ID: ${recurring.id} • Gunakan /repeat delete untuk menghapus` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        logger.error({ err }, 'Gagal membuat recurring task');
        await interaction.editReply('❌ Terjadi kesalahan saat membuat tugas berulang.');
      }
      return;
    }

    if (sub === 'list') {
      await interaction.deferReply({ ephemeral: true });

      try {
        const recurrings = await TaskService.getUserRecurringTasks(
          interaction.user.id,
          interaction.guildId || undefined
        );

        if (recurrings.length === 0) {
          await interaction.editReply('📭 Kamu belum memiliki tugas berulang aktif. Buat dengan `/repeat create`!');
          return;
        }

        const dayNames = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
        const patternEmoji: Record<string, string> = { 'DAILY': '📅', 'WEEKLY': '📆', 'BIWEEKLY': '🗓️' };

        const embed = new EmbedBuilder()
          .setTitle('🔁 Daftar Tugas Berulang Aktif')
          .setColor('#9B59B6')
          .setDescription(
            recurrings.map((r, i) => {
              const schedInfo = r.repeatPattern === 'DAILY'
                ? 'Setiap Hari'
                : `${r.repeatPattern === 'BIWEEKLY' ? '2 Mingguan' : 'Mingguan'}, ${dayNames[r.dayOfWeek ?? 0]}`;
              const hourWIB = (r.hourUTC + 7) % 24;
              const timeStr = `${String(hourWIB).padStart(2, '0')}:${String(r.minuteUTC).padStart(2, '0')} WIB`;
              const nextRun = `<t:${Math.floor(r.nextRunAt.getTime() / 1000)}:R>`;
              return `**${i + 1}.** ${patternEmoji[r.repeatPattern] || '🔁'} **${r.title}**\n` +
                `   ${schedInfo} jam ${timeStr} | Berikutnya: ${nextRun}\n` +
                `   \`ID: ${r.id}\``;
            }).join('\n\n')
          )
          .setFooter({ text: 'Gunakan /repeat delete id:<ID> untuk menghapus' })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        logger.error({ err }, 'Gagal mengambil daftar recurring tasks');
        await interaction.editReply('❌ Gagal mengambil daftar tugas berulang.');
      }
      return;
    }

    if (sub === 'delete') {
      await interaction.deferReply({ ephemeral: true });
      const recurringId = interaction.options.getString('id', true);

      try {
        const deleted = await TaskService.deleteRecurringTask(recurringId, interaction.user.id);
        if (!deleted) {
          await interaction.editReply('❌ Tugas berulang tidak ditemukan atau bukan milikmu.');
          return;
        }

        await interaction.editReply(`✅ Tugas berulang **"${deleted.title}"** berhasil dinonaktifkan. Tidak akan ada tugas baru yang dibuat dari jadwal ini.`);
      } catch (err) {
        logger.error({ err }, 'Gagal menghapus recurring task');
        await interaction.editReply('❌ Gagal menghapus tugas berulang.');
      }
      return;
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

