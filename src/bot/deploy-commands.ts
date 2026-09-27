import { REST, Routes, SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType } from 'discord.js';
import { env } from '../config/env';
import { logger } from '../shared/utils/logger';

const commands = [
  new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Bangun otomatis kategori & channel TaskFlow OS di server ini!'),
  new SlashCommandBuilder()
    .setName('task')
    .setDescription('Buat task baru dengan bantuan AI (Paham bahasa sehari-hari!)')
    .addStringOption(option =>
      option.setName('input')
        .setDescription('Deskripsikan tugas (contoh: "Besok malem jam 8 kerjain laporan AI")')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('tasks')
    .setDescription('Daftar semua tugas aktif kamu & tombol checklist'),
  new SlashCommandBuilder()
    .setName('today')
    .setDescription('Deadline Radar: Lihat tugas-tugas kamu untuk hari ini'),
  new SlashCommandBuilder()
    .setName('week')
    .setDescription('Weekly Agenda Horizon: Lihat seluruh jadwal tugas 7 hari ke depan'),
  new SlashCommandBuilder()
    .setName('plan')
    .setDescription('AI Daily Planner: Susun jadwal belajar & time-blocking cerdas dari tugas aktifmu')
    .addStringOption(option =>
      option.setName('waktu')
        .setDescription('Rentang waktu luangmu (contoh: "19:00 - 23:00" atau "malam ini 3 jam")')
        .setRequired(false)
    ),
  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Lihat profil produktivitasmu (XP, Level, Streak, dan Selesai)'),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Lihat papan peringkat produktivitas XP & Streak di server ini'),
  new SlashCommandBuilder()
    .setName('briefing')
    .setDescription('Kirim Morning Briefing ringkasan tugas hari ini ke channel radar sekarang'),
  new SlashCommandBuilder()
    .setName('rekap')
    .setDescription('Export rekap tugas terformat rapi untuk di-copas ke WhatsApp/Telegram')
    .addStringOption(option =>
      option.setName('cakupan')
        .setDescription('Pilih cakupan rekap: Seluruh Tugas Server atau Tugas Saya')
        .addChoices(
          { name: '🌐 Seluruh Tugas Server (Untuk Grup Kelas)', value: 'server' },
          { name: '👤 Tugas Pribadi Saya Saja', value: 'saya' }
        )
    ),
  new SlashCommandBuilder()
    .setName('workload')
    .setDescription('Deteksi Beban Kerja: Analisis jam tugas hari ini vs kapasitas & alert burnout'),
  new SlashCommandBuilder()
    .setName('review')
    .setDescription('Weekly Productivity Review: Laporan 7 hari, jam fokus Pomodoro & AI Coaching'),
  new SlashCommandBuilder()
    .setName('course')
    .setDescription('Mode Mata Kuliah: Pantau tugas terkelompok per matkul & progress bar')
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('Lihat seluruh mata kuliah aktif di server beserta persentase selesai')
    )
    .addSubcommand(sub =>
      sub.setName('tasks')
        .setDescription('Lihat seluruh tugas untuk mata kuliah tertentu')
        .addStringOption(opt =>
          opt.setName('nama')
            .setDescription('Nama mata kuliah (contoh: Kalkulus, Pemrograman Web)')
            .setRequired(true)
        )
    ),
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Tanya AI apa saja tentang tugas, deadline, jadwal, dan progres belajarmu')
    .addStringOption(opt =>
      opt.setName('pertanyaan')
        .setDescription('Pertanyaanmu (contoh: "Tugas apa yang paling mepet?" atau "Tugas kelompok AI kurang apa?")')
        .setRequired(true)
    ),
  new ContextMenuCommandBuilder()
    .setName('Add to TaskFlow')
    .setType(ApplicationCommandType.Message)
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(env.BOT_TOKEN);

export async function deployCommands(clientId: string, guildIds: string[] = []) {
  try {
    logger.info(`Memulai registrasi ${commands.length} Commands...`);

    const targetGuilds = env.GUILD_ID ? [env.GUILD_ID] : guildIds;

    if (targetGuilds.length > 0) {
      // 1. Daftarkan ke Guild/Server agar aktif INSTAN
      for (const gId of targetGuilds) {
        await rest.put(Routes.applicationGuildCommands(clientId, gId), { body: commands });
        logger.info(`⚡ Commands aktif instan di Guild/Server ID: ${gId}`);
      }
      // 2. Kosongkan Global commands agar tidak muncul dobel di server yang sama
      await rest.put(Routes.applicationCommands(clientId), { body: [] });
      logger.info('✅ Global commands dibersihkan (mencegah duplikasi).');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      logger.info('✅ Commands berhasil didaftarkan secara Global.');
    }
  } catch (error) {
    logger.error({ err: error }, 'Gagal mendaftarkan commands');
  }
}
