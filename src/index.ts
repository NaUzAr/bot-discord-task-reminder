import { Client, GatewayIntentBits, EmbedBuilder } from 'discord.js';
import { env } from './config/env';
import { logger } from './shared/utils/logger';
import { deployCommands } from './bot/deploy-commands';
import { AIService } from './modules/ai/ai.service';
import { TaskService } from './modules/task/task.service';
import { prisma } from './database/prisma';

// 🔄 Menyalakan BullMQ Worker secara otomatis saat bot berjalan!
import './workers/reminder.worker'; 

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
  ]
});

client.once('ready', async () => {
  logger.info(`🤖 Bot is ready! Logged in as ${client.user?.tag}`);
  if (client.user) {
    await deployCommands(client.user.id);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

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

      await interaction.editReply(`✅ **Task Berhasil Dibuat & Reminder Dijadwalkan!**\n\n📌 **Judul:** ${task.title}\n⏰ **Deadline:** ${deadlineText}\n🔥 **Prioritas:** ${task.priority}`);
    } catch (err) {
      logger.error({ err }, 'Gagal menyimpan task ke database');
      await interaction.editReply('❌ Terjadi kesalahan saat menyimpan ke database.');
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
          tasks.map((t, i) => `**${i + 1}. ${t.title}**\n⏰ <t:${Math.floor(t.dueAt!.getTime() / 1000)}:R> - 🔥 ${t.priority}`).join('\n\n')
        );

      await interaction.editReply({ embeds: [embed] });
    } catch (err) {
      logger.error({ err }, 'Gagal mengambil data today');
      await interaction.editReply('❌ Gagal mengambil data.');
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
