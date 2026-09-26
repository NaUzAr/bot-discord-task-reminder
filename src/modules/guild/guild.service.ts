import { Guild, ChannelType, EmbedBuilder, PermissionFlagsBits, TextChannel } from 'discord.js';
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

      // Welcome Card di Inbox
      const inboxEmbed = new EmbedBuilder()
        .setTitle('📥 TaskFlow Inbox Aktif!')
        .setDescription(
          'Selamat datang di **Task Inbox**! Channel ini khusus untuk mencatat tugas secara instan tanpa command rumit.\n\n' +
          '💬 **Cukup ketik pesan biasa di sini:**\n' +
          '> *"Besok jam 8 malam kumpul laporan kalkulus di https://classroom.google.com/"*\n\n' +
          '⚡ AI otomatis membuat **Thread Rapi** untuk setiap tugas agar channel tetap bersih & tidak spam!'
        )
        .setColor('#00E5FF')
        .setFooter({ text: 'TaskFlow OS • Auto-Listen Powered by Gemini AI' });
      await inboxChannel.send({ embeds: [inboxEmbed] });
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
        topic: 'Papan radar deadline tugas server (Read-Only)',
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

      // Welcome Card di Radar
      const radarEmbed = new EmbedBuilder()
        .setTitle('🚨 Deadline Radar Aktif!')
        .setDescription(
          'Channel ini adalah pusat pemantauan tugas bersama di server ini.\n' +
          'Papan ini bersifat **Read-Only** agar pengumuman tugas selalu bersih dan mudah dibaca!'
        )
        .setColor('#FFCC00')
        .setFooter({ text: 'Ketik /today untuk melihat tugas deadline hari ini' });
      await radarChannel.send({ embeds: [radarEmbed] });
    }

    // 4. Simpan ke Database
    await prisma.guild.upsert({
      where: { discordGuildId: guild.id },
      update: {
        name: guild.name,
        inboxChannelId: inboxChannel.id,
        radarChannelId: radarChannel.id,
      },
      create: {
        discordGuildId: guild.id,
        name: guild.name,
        inboxChannelId: inboxChannel.id,
        radarChannelId: radarChannel.id,
      }
    });

    return {
      category,
      inboxChannel,
      radarChannel
    };
  }
}
