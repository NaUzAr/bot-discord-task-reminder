import { Guild, ChannelType, EmbedBuilder, PermissionFlagsBits, TextChannel, VoiceChannel, ActionRowBuilder, ButtonBuilder, ButtonStyle, Client } from 'discord.js';
import { prisma } from '../../database/prisma';
import { logger } from '../../shared/utils/logger';

export class GuildService {
  static async setupGuildOS(guild: Guild) {
    logger.info(`Setting up streamlined TaskFlow OS for guild: ${guild.name} (${guild.id})`);

    // 1. Cari atau buat Kategori "📁 ━━━━ TASKFLOW OS ━━━━"
    let category = guild.channels.cache.find(
      c => c.type === ChannelType.GuildCategory && c.name.toLowerCase().includes('taskflow os')
    );

    if (!category) {
      category = await guild.channels.create({
        name: '📁 ━━━━ TASKFLOW OS ━━━━',
        type: ChannelType.GuildCategory
      });
    }

    // 2. Buat atau temukan channel 1: 📥・inbox-tugas
    let inboxChannel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name.includes('inbox')
    ) as TextChannel | undefined;

    if (!inboxChannel) {
      inboxChannel = await guild.channels.create({
        name: '📥・inbox-tugas',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: 'Ketik tugas/deadline santai di sini. AI TaskFlow akan otomatis mengekstrak & membuat thread checklist!'
      }) as TextChannel;
    }

    // 3. Buat atau temukan channel 2: 🚨・deadline-radar (READ ONLY untuk member agar bersih)
    let radarChannel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name.includes('deadline-radar')
    ) as TextChannel | undefined;

    if (!radarChannel) {
      radarChannel = await guild.channels.create({
        name: '🚨・deadline-radar',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: 'Papan Live Radar deadline tugas server (Read-Only • Auto-Update Realtime)',
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: [PermissionFlagsBits.SendMessages] // Member tidak bisa spam chat di sini
          },
          {
            id: guild.client.user.id,
            allow: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks]
          }
        ]
      }) as TextChannel;
    }

    // 4. Buat atau temukan channel 3: 🎯・fokus-room (Pomodoro Focus Controller & Aktivitas Deep Work)
    let focusChannel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildText && c.name.includes('fokus-room')
    ) as TextChannel | undefined;

    if (!focusChannel) {
      focusChannel = await guild.channels.create({
        name: '🎯・fokus-room',
        type: ChannelType.GuildText,
        parent: category.id,
        topic: 'Pomodoro Hub: Masuk ke sesi fokus untuk produktivitas maksimal & status @In Focus'
      }) as TextChannel;
    }

    // 5. Buat atau temukan channel 4: 🎧・Focus Room (Voice)
    let voiceChannel = guild.channels.cache.find(
      c => c.type === ChannelType.GuildVoice && c.name.toLowerCase().includes('focus room')
    ) as VoiceChannel | undefined;

    if (!voiceChannel) {
      voiceChannel = await guild.channels.create({
        name: '🎧・Focus Room (Voice)',
        type: ChannelType.GuildVoice,
        parent: category.id
      }).catch(() => undefined);
    }

    // 6. Buat atau temukan Role "🧘 In Focus"
    let focusRole = guild.roles.cache.find(r => r.name.toLowerCase().includes('in focus'));
    if (!focusRole) {
      focusRole = await guild.roles.create({
        name: '🧘 In Focus',
        color: '#9B59B6',
        hoist: true,
        reason: 'Role status untuk member yang sedang dalam sesi fokus (Do Not Disturb)'
      }).catch(() => undefined);
    }

    // 7. Simpan referensi channel ke database Guild
    await prisma.guild.upsert({
      where: { discordGuildId: guild.id },
      update: {
        name: guild.name,
        inboxChannelId: inboxChannel.id,
        radarChannelId: radarChannel.id,
        focusChannelId: focusChannel.id
      },
      create: {
        discordGuildId: guild.id,
        name: guild.name,
        inboxChannelId: inboxChannel.id,
        radarChannelId: radarChannel.id,
        focusChannelId: focusChannel.id
      }
    });

    // 8. Update atau kirim Panduan di Inbox
    await this.updateInboxGuide(guild, inboxChannel, radarChannel.id);

    // 9. Update atau pasang Live Radar Dashboard di channel radar
    await this.updateRadarDashboard(guild);

    // 10. Pasang Focus Hub Guide di channel fokus-room
    await this.updateFocusHubGuide(guild, focusChannel, voiceChannel?.id);

    return {
      category,
      inboxChannel,
      radarChannel,
      focusChannel,
      voiceChannel,
      focusRole
    };
  }

  /**
   * Mengirim atau memperbarui Kartu Focus Hub di channel fokus-room
   */
  static async updateFocusHubGuide(guild: Guild, focusChannel: TextChannel, voiceChannelId?: string) {
    try {
      const voiceMention = voiceChannelId ? `<#${voiceChannelId}>` : '🎧・Focus Room (Voice)';

      const focusHubEmbed = new EmbedBuilder()
        .setTitle('🎯 TaskFlow Pomodoro Focus Hub')
        .setDescription(
          'Selamat datang di **Focus Hub**! Aktifkan sesi fokus untuk menaikkan konsentrasi dan mendapatkan reward produktivitas.\n\n' +
          '⚡ **Yang Terjadi Saat Kamu Fokus:**\n' +
          '• 🧘 Kamu mendapatkan status role **`@In Focus`** di server (Do Not Disturb aktif).\n' +
          '• 📢 Bot mengumumkan sesi fokusmu di channel ini agar tidak ada yang mendistraksi.\n' +
          '• ☕ Bot otomatis mengirim DM pengingat saat sesi berakhir untuk istirahat sejenak.\n' +
          '• 🏆 Dapatkan **+25 XP** (25 Menit) atau **+50 XP** (50 Menit) untuk naik level di `/leaderboard`!\n\n' +
          `🎧 *Tips: Kamu juga bisa bergabung ke channel suara ${voiceMention} untuk belajar bareng sambil mendengarkan musik lo-fi.*`
        )
        .setColor('#9B59B6')
        .setFooter({ text: 'Klik tombol di bawah untuk langsung mengaktifkan sesi fokus!' });

      const focusButtons = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('room_focus_25')
          .setLabel('🎯 Fokus 25 Menit (+25 XP)')
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId('room_focus_50')
          .setLabel('🔥 Deep Work 50 Menit (+50 XP)')
          .setStyle(ButtonStyle.Primary)
      );

      const recent = await focusChannel.messages.fetch({ limit: 10 }).catch(() => null);
      const existing = recent?.find(m => m.author.id === guild.client.user.id && m.embeds[0]?.title?.includes('Focus Hub'));
      if (existing) {
        await existing.edit({ embeds: [focusHubEmbed], components: [focusButtons] });
      } else {
        await focusChannel.send({ embeds: [focusHubEmbed], components: [focusButtons] });
      }
    } catch (err) {
      logger.warn({ err }, 'Gagal update focus hub guide');
    }
  }

  /**
   * Mengirim atau memperbarui Kartu Panduan di channel inbox-tugas
   */
  static async updateInboxGuide(guild: Guild, inboxChannel: TextChannel, radarChannelId?: string) {
    try {
      const dbGuild = await prisma.guild.findUnique({
        where: { discordGuildId: guild.id }
      });

      const radarId = radarChannelId || dbGuild?.radarChannelId;
      const radarMention = radarId ? `<#${radarId}>` : '🚨・deadline-radar';

      const inboxEmbed = new EmbedBuilder()
        .setTitle('📥 TaskFlow Inbox (Auto-Listen Aktif)')
        .setDescription(
          'Selamat datang di **TaskFlow Inbox**! Channel ini khusus untuk mencatat tugas secara instan tanpa command rumit.\n\n' +
          '💬 **Cara Menulis Tugas:**\n' +
          '• 👤 **Tugas Individu:** Ketik tugas biasa tanpa tag orang\n' +
          '> *"Besok jam 8 malam kumpul laporan kalkulus di https://classroom.google.com/"*\n\n' +
          '• 👥 **Tugas Kelompok:** Ketik tugas sambil tag teman (@teman)\n' +
          '> *"Besok jam 8 malam kumpul laporan fisika @Budi @Siti di https://classroom.google.com/"*\n' +
          '> *(Anggota yang di-tag otomatis diundang ke thread dan diingatkan via DM!)*\n\n' +
          '⚡ **Fitur Cerdas TaskFlow:**\n' +
          `• 📊 **Live Radar:** Pantau semua tugas aktif server secara realtime di ${radarMention}!\n` +
          '• 🧵 **Auto-Thread:** Rincian, checklist AI breakdown, dan tombol selesai ada di thread.\n' +
          '• 🗑️ **Auto-Clean:** Saat tugas selesai (`✅ Selesai`), thread & chat otomatis lenyap agar channel tetap 100% bersih!'
        )
        .setColor('#00E5FF')
        .setFooter({ text: 'TaskFlow OS • Powered by Gemini AI • Live Auto-Update' });

      let targetMsg = null;
      if (dbGuild?.inboxGuideMessageId) {
        targetMsg = await inboxChannel.messages.fetch(dbGuild.inboxGuideMessageId).catch(() => null);
      }

      if (!targetMsg) {
        // Cari apakah ada pesan dari bot sebelumnya di inboxChannel
        const recentMessages = await inboxChannel.messages.fetch({ limit: 10 }).catch(() => null);
        const botMsg = recentMessages?.find(m => m.author.id === guild.client.user.id);
        if (botMsg) {
          targetMsg = botMsg;
        }
      }

      if (targetMsg) {
        await targetMsg.edit({ embeds: [inboxEmbed] });
        await prisma.guild.upsert({
          where: { discordGuildId: guild.id },
          update: { inboxGuideMessageId: targetMsg.id },
          create: { discordGuildId: guild.id, name: guild.name, inboxGuideMessageId: targetMsg.id }
        });
      } else {
        const sent = await inboxChannel.send({ embeds: [inboxEmbed] });
        await prisma.guild.upsert({
          where: { discordGuildId: guild.id },
          update: { inboxGuideMessageId: sent.id },
          create: { discordGuildId: guild.id, name: guild.name, inboxGuideMessageId: sent.id }
        });
      }
    } catch (err) {
      logger.warn({ err }, 'Gagal update inbox guide');
    }
  }

  /**
   * Memperbarui Papan Radar Live (Realtime Dashboard) di channel deadline-radar
   */
  static async updateRadarDashboard(guildOrId: Guild | string, clientInstance?: Client) {
    try {
      const guildId = typeof guildOrId === 'string' ? guildOrId : guildOrId.id;
      const dbGuild = await prisma.guild.findUnique({
        where: { discordGuildId: guildId }
      });

      if (!dbGuild || !dbGuild.radarChannelId) return;

      const client = (typeof guildOrId !== 'string' ? guildOrId.client : clientInstance);
      if (!client) return;

      const radarChannel = await client.channels.fetch(dbGuild.radarChannelId).catch(() => null) as TextChannel | null;
      if (!radarChannel) return;

      // Ambil semua tugas aktif di guild ini
      const activeTasks = await prisma.task.findMany({
        where: {
          guildId: dbGuild.id,
          status: { in: ['TODO', 'IN_PROGRESS'] },
          deletedAt: null
        },
        orderBy: [
          { dueAt: 'asc' },
          { priority: 'desc' }
        ],
        take: 15
      });

      const priorityEmoji: Record<string, string> = {
        URGENT: '🚨',
        HIGH: '🔥',
        MEDIUM: '⚡',
        LOW: '🌱'
      };

      const hasUrgent = activeTasks.some(t => t.priority === 'URGENT' || t.priority === 'HIGH');
      const embedColor = activeTasks.length === 0 ? '#00FF7F' : (hasUrgent ? '#FF3366' : '#FFCC00');

      const radarEmbed = new EmbedBuilder()
        .setTitle('🚨 Live Deadline Radar Dashboard')
        .setColor(embedColor)
        .setTimestamp();

      if (activeTasks.length === 0) {
        radarEmbed.setDescription(
          '🎉 **Semua Tugas Telah Selesai!**\n\n' +
          'Tidak ada deadline aktif yang perlu dikerjakan saat ini. Server dalam kondisi santai! ☕\n\n' +
          `*Ketik tugas baru di channel <#${dbGuild.inboxChannelId}> untuk otomatis memunculkan tugas di papan ini.*`
        );
      } else {
        const taskEntries = activeTasks.map((t, idx) => {
          const typeBadge = t.taskType === 'GROUP' ? '👥 [Kelompok]' : '👤 [Individu]';
          const pEmoji = priorityEmoji[t.priority] || '⚡';
          const dlText = t.dueAt 
            ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R> (<t:${Math.floor(t.dueAt.getTime() / 1000)}:F>)` 
            : 'Tidak ada batas waktu';

          const memberText = (t.taskType === 'GROUP' && t.assignedUserIds?.length > 0)
            ? t.assignedUserIds.map(id => `<@${id}>`).join(', ')
            : `<@${t.userId}>`;

          const linkLine = t.linkUrl ? `\n> 🔗 **Tautan:** [Klik untuk Membuka Tugas](${t.linkUrl})` : '';

          return (
            `**${idx + 1}. ${pEmoji} ${typeBadge} ${t.title}**\n` +
            `> ⏰ **Deadline:** ${dlText}\n` +
            `> 👥 **Anggota/Pembuat:** ${memberText}${linkLine}`
          );
        });

        radarEmbed.setDescription(
          `📊 **Total Tugas Aktif:** **${activeTasks.length} Tugas**\n` +
          `Pusat monitoring tugas server secara real-time. Card ini **otomatis ter-update** setiap ada tugas baru atau tugas selesai!\n\n` +
          taskEntries.join('\n\n')
        );
      }

      radarEmbed.setFooter({ 
        text: '🔄 Live Auto-Update Realtime • TaskFlow OS',
      });

      let targetMsg = null;
      if (dbGuild.radarMessageId) {
        targetMsg = await radarChannel.messages.fetch(dbGuild.radarMessageId).catch(() => null);
      }

      if (!targetMsg) {
        // Cari pesan bot sebelumnya di channel radar
        const recentMessages = await radarChannel.messages.fetch({ limit: 10 }).catch(() => null);
        const botMsg = recentMessages?.find(m => m.author.id === client.user?.id);
        if (botMsg) {
          targetMsg = botMsg;
        }
      }

      if (targetMsg) {
        await targetMsg.edit({ embeds: [radarEmbed] });
        if (dbGuild.radarMessageId !== targetMsg.id) {
          await prisma.guild.update({
            where: { id: dbGuild.id },
            data: { radarMessageId: targetMsg.id }
          });
        }
        logger.info(`Radar dashboard message ${targetMsg.id} updated in guild ${guildId}`);
      } else {
        const sent = await radarChannel.send({ embeds: [radarEmbed] });
        await prisma.guild.update({
          where: { id: dbGuild.id },
          data: { radarMessageId: sent.id }
        });
        logger.info(`New radar dashboard message ${sent.id} sent in guild ${guildId}`);
      }

      // Broadcast SSE ke web dashboard agar data ter-sync instan tanpa delay
      try {
        const { sseService } = await import('../../web/services/sse.service');
        sseService.broadcast('task:changed', { source: 'discord_bot', guildId });
      } catch {}
    } catch (err) {
      logger.warn({ err }, 'Gagal update radar dashboard');
    }
  }

  /**
   * Membersihkan channel inbox-tugas dari pesan chat atau orphan messages,
   * menyisakan hanya pesan Panduan Utama agar inbox selalu 100% bersih seperti drop-zone baru.
   */
  static async cleanInboxChannel(guildOrId: Guild | string, clientInstance?: Client, maxAgeSeconds = 15) {
    try {
      const guildId = typeof guildOrId === 'string' ? guildOrId : guildOrId.id;
      const dbGuild = await prisma.guild.findUnique({
        where: { discordGuildId: guildId }
      });

      if (!dbGuild || !dbGuild.inboxChannelId) return;

      const client = (typeof guildOrId !== 'string' ? guildOrId.client : clientInstance);
      if (!client) return;

      // Cek cache lokal terlebih dahulu untuk menghindari unnecessary REST API call ke Discord
      let inboxChannel: TextChannel | null = null;
      if (typeof guildOrId !== 'string') {
        inboxChannel = (guildOrId.channels.cache.get(dbGuild.inboxChannelId) as TextChannel) || null;
      }
      if (!inboxChannel) {
        inboxChannel = await client.channels.fetch(dbGuild.inboxChannelId).catch(() => null) as TextChannel | null;
      }
      if (!inboxChannel || !('messages' in inboxChannel)) return;

      const messages = await inboxChannel.messages.fetch({ limit: 20 }).catch(() => null);
      if (!messages || messages.size === 0) return;

      const now = Date.now();
      for (const msg of messages.values()) {
        // Jangan hapus pesan panduan inbox utama!
        if (dbGuild.inboxGuideMessageId && msg.id === dbGuild.inboxGuideMessageId) continue;

        // Hapus jika usia pesan sudah melebihi batas waktu (misal > 15 detik)
        const ageMs = now - msg.createdTimestamp;
        if (ageMs > maxAgeSeconds * 1000) {
          await msg.delete().catch(() => null);
          logger.info(`[Inbox Cleaner] Pesan lama ${msg.id} di #${inboxChannel.name} berhasil dibersihkan.`);
        }
      }
    } catch (err) {
      logger.warn({ err }, 'Gagal membersihkan inbox channel');
    }
  }
}

