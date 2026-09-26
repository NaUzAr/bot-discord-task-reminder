import { Guild, ChannelType, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, TextChannel } from 'discord.js';
import { prisma } from '../../database/prisma';
import { logger } from '../../shared/utils/logger';

export class GuildService {
  static async setupGuildOS(guild: Guild) {
    logger.info(`Setting up TaskFlow OS for guild: ${guild.name} (${guild.id})`);

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

    // 2. Buat atau temukan channel-channel pendukung di dalam kategori
    const getOrCreateChannel = async (name: string, topic: string) => {
      let channel = guild.channels.cache.find(
        c => c.type === ChannelType.GuildText && c.name === name
      ) as TextChannel | undefined;

      if (!channel) {
        channel = await guild.channels.create({
          name,
          type: ChannelType.GuildText,
          parent: category.id,
          topic
        }) as TextChannel;
      }
      return channel;
    };

    const inboxChannel = await getOrCreateChannel(
      '📥・inbox-tugas',
      'Drop chat tugas/deadline di sini. AI TaskFlow akan otomatis menjadwalkannya!'
    );

    const radarChannel = await getOrCreateChannel(
      '🚨・deadline-radar',
      'Papan radar pengumuman deadline tugas bersama & reminder harian'
    );

    const focusChannel = await getOrCreateChannel(
      '🎯・focus-room',
      'Ruang Pomodoro bersama. Klik tombol untuk memulai sesi fokus belajar/nugas!'
    );

    const leaderboardChannel = await getOrCreateChannel(
      '🏆・leaderboard',
      'Papan peringkat XP & Streak Produktivitas mahasiswa/anggota'
    );

    // 3. Simpan data channel ke database PostgreSQL
    await prisma.guild.upsert({
      where: { discordGuildId: guild.id },
      update: {
        name: guild.name,
        inboxChannelId: inboxChannel.id,
        radarChannelId: radarChannel.id,
        focusChannelId: focusChannel.id,
        leaderboardChannelId: leaderboardChannel.id,
      },
      create: {
        discordGuildId: guild.id,
        name: guild.name,
        inboxChannelId: inboxChannel.id,
        radarChannelId: radarChannel.id,
        focusChannelId: focusChannel.id,
        leaderboardChannelId: leaderboardChannel.id,
      }
    });

    // 4. Kirim Welcome Cards ke channel-channel baru

    // Inbox Card
    const inboxEmbed = new EmbedBuilder()
      .setTitle('📥 TaskFlow Auto-Listen Inbox Aktif!')
      .setDescription(
        'Selamat datang di **Task Inbox**! Kamu tidak perlu repot mengetik command rumit.\n\n' +
        '💬 **Cukup ketik pesan obrolan biasa di channel ini:**\n' +
        '> *"Besok sore jam 3 kumpul laporan praktikum fisika ya guys"*\n\n' +
        '⚡ AI TaskFlow akan otomatis mendeteksi, mencatat, dan menjadwalkan reminder!'
      )
      .setColor('#00E5FF')
      .setFooter({ text: 'TaskFlow OS • Auto-Listen Powered by Gemini AI' });
    await inboxChannel.send({ embeds: [inboxEmbed] });

    // Radar Card
    const radarEmbed = new EmbedBuilder()
      .setTitle('🚨 Deadline Radar Aktif!')
      .setDescription(
        'Channel ini adalah pusat pemantauan tugas bersama di server ini.\n' +
        'Tugas yang dibuat di inbox atau via `/task` akan dipantau di sini!'
      )
      .setColor('#FFCC00')
      .setFooter({ text: 'Ketik /today untuk melihat ringkasan deadline hari ini' });
    await radarChannel.send({ embeds: [radarEmbed] });

    // Focus Room Card with persistent buttons
    const focusEmbed = new EmbedBuilder()
      .setTitle('🎯 Pomodoro Focus Lounge')
      .setDescription(
        'Tingkatkan produktivitas belajar dan nugasmu dengan teknik Pomodoro!\n\n' +
        'Pilih durasi fokus di bawah. Bot akan mengunci fokusmu dan mengingatkan saat waktu istirahat tiba! ☕'
      )
      .setColor('#9B59B6')
      .addFields(
        { name: '🎯 25 Menit', value: 'Sesi Pomodoro Klasik (+25 XP)', inline: true },
        { name: '⏱️ 50 Menit', value: 'Deep Work Session (+50 XP)', inline: true }
      );

    const focusRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('room_focus_25')
        .setLabel('Mulai Fokus 25m')
        .setStyle(ButtonStyle.Primary)
        .setEmoji('🎯'),
      new ButtonBuilder()
        .setCustomId('room_focus_50')
        .setLabel('Mulai Fokus 50m')
        .setStyle(ButtonStyle.Success)
        .setEmoji('⏱️')
    );
    await focusChannel.send({ embeds: [focusEmbed], components: [focusRow] });

    // Leaderboard Card
    const lbEmbed = new EmbedBuilder()
      .setTitle('🏆 Productivity Hall of Fame')
      .setDescription(
        'Kumpulkan **XP** dan pertahankan **Daily Streak** dengan:\n' +
        '• Menyelesaikan tugas tepat waktu (+50 XP)\n' +
        '• Menuntaskan sesi fokus Pomodoro (+25 XP)\n\n' +
        '*Papan peringkat akan otomatis diperbarui setiap ada tugas selesai!*'
      )
      .setColor('#F1C40F')
      .setFooter({ text: 'Ketik /stats untuk cek profilmu' });
    await leaderboardChannel.send({ embeds: [lbEmbed] });

    return {
      category,
      inboxChannel,
      radarChannel,
      focusChannel,
      leaderboardChannel
    };
  }
}
