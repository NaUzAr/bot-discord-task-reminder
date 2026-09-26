import { REST, Routes, SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType } from 'discord.js';
import { env } from '../config/env';
import { logger } from '../shared/utils/logger';

const commands = [
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
  new ContextMenuCommandBuilder()
    .setName('Add to TaskFlow')
    .setType(ApplicationCommandType.Message)
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(env.BOT_TOKEN);

export async function deployCommands(clientId: string) {
  try {
    logger.info(`Memulai registrasi ${commands.length} Slash Commands...`);

    if (env.GUILD_ID) {
      await rest.put(Routes.applicationGuildCommands(clientId, env.GUILD_ID), { body: commands });
      logger.info('✅ Slash commands berhasil didaftarkan untuk Guild (Server) lokal.');
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: commands });
      logger.info('✅ Slash commands berhasil didaftarkan secara Global.');
    }
  } catch (error) {
    logger.error({ err: error }, 'Gagal mendaftarkan commands');
  }
}
