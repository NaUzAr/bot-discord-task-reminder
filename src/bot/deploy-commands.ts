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
    .setName('stats')
    .setDescription('Lihat profil produktivitasmu (XP, Level, Streak, dan Selesai)'),
  new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Lihat papan peringkat produktivitas XP & Streak di server ini'),
  new ContextMenuCommandBuilder()
    .setName('Add to TaskFlow')
    .setType(ApplicationCommandType.Message)
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(env.BOT_TOKEN);

export async function deployCommands(clientId: string, guildIds: string[] = []) {
  try {
    logger.info(`Memulai registrasi ${commands.length} Commands...`);

    // 1. Daftarkan langsung ke Guild/Server agar aktif INSTAN (tanpa jeda 1 jam Discord cache)
    const targetGuilds = env.GUILD_ID ? [env.GUILD_ID] : guildIds;
    for (const gId of targetGuilds) {
      await rest.put(Routes.applicationGuildCommands(clientId, gId), { body: commands });
      logger.info(`⚡ Commands langsung aktif instan di Guild/Server ID: ${gId}`);
    }

    // 2. Daftarkan juga secara Global (untuk Direct Message / server baru)
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    logger.info('✅ Commands berhasil didaftarkan secara Global.');
  } catch (error) {
    logger.error({ err: error }, 'Gagal mendaftarkan commands');
  }
}
