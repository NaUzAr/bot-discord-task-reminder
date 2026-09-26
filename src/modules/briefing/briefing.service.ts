import { Client, EmbedBuilder, TextChannel } from 'discord.js';
import { prisma } from '../../database/prisma';
import { logger } from '../../shared/utils/logger';

export class BriefingService {
  private static lastBriefingDate: string = '';

  /**
   * Mengirim ringkasan tugas pagi hari ke channel radar dan DM mahasiswa
   */
  static async sendMorningBriefing(client: Client, targetGuildId?: string) {
    logger.info('Menjalankan Daily Morning Briefing...');

    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const endOfDay = new Date();
    endOfDay.setHours(23, 59, 59, 999);

    const next48h = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const guilds = await prisma.guild.findMany({
      where: targetGuildId ? { discordGuildId: targetGuildId } : undefined
    });

    for (const g of guilds) {
      if (!g.radarChannelId) continue;

      try {
        const discordGuild = await client.guilds.fetch(g.discordGuildId).catch(() => null);
        if (!discordGuild) continue;

        const radarChannel = await client.channels.fetch(g.radarChannelId).catch(() => null) as TextChannel | null;
        if (!radarChannel) continue;

        // Cari tugas deadline hari ini di guild ini
        const todayTasks = await prisma.task.findMany({
          where: {
            guildId: g.id,
            status: { in: ['TODO', 'IN_PROGRESS'] },
            deletedAt: null,
            dueAt: { gte: startOfDay, lte: endOfDay }
          },
          orderBy: { dueAt: 'asc' }
        });

        // Cari tugas mendekati dalam 48 jam ke depan (selain hari ini)
        const upcomingTasks = await prisma.task.findMany({
          where: {
            guildId: g.id,
            status: { in: ['TODO', 'IN_PROGRESS'] },
            deletedAt: null,
            dueAt: { gt: endOfDay, lte: next48h }
          },
          orderBy: { dueAt: 'asc' },
          take: 5
        });

        const embed = new EmbedBuilder()
          .setTitle(`☀️ Selamat Pagi, ${discordGuild.name}! (Morning Briefing)`)
          .setColor('#FFA500')
          .setTimestamp();

        if (todayTasks.length === 0 && upcomingTasks.length === 0) {
          embed.setDescription(
            '🎉 **Hari ini tidak ada deadline tugas!**\n\n' +
            'Semua tugas dalam kondisi aman. Nikmati harimu dengan santai atau manfaatkan waktu untuk eksplorasi hal baru! ☕\n\n' +
            `*Ingin mencatat tugas baru? Cukup ketik di <#${g.inboxChannelId}>.*`
          );
        } else {
          let description = 'Semangat pagi! Berikut rangkuman tugas yang perlu kamu dan tim perhatikan hari ini:\n\n';

          if (todayTasks.length > 0) {
            description += `🚨 **DEADLINE HARI INI (${todayTasks.length} Tugas):**\n`;
            description += todayTasks.map((t, idx) => {
              const badge = t.taskType === 'GROUP' ? '👥 [Kelompok]' : '👤 [Individu]';
              const dl = t.dueAt ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R> (<t:${Math.floor(t.dueAt.getTime() / 1000)}:t>)` : 'Hari ini';
              const member = (t.taskType === 'GROUP' && t.assignedUserIds?.length > 0)
                ? t.assignedUserIds.map(id => `<@${id}>`).join(', ')
                : `<@${t.userId}>`;
              const link = t.linkUrl ? ` | 🔗 [Link Tugas](${t.linkUrl})` : '';

              return `**${idx + 1}. ${badge} ${t.title}**\n> ⏰ Deadline: ${dl}\n> 👤 Penanggung jawab: ${member}${link}`;
            }).join('\n\n');
          } else {
            description += '✅ **Hari ini tidak ada deadline tugas langsung.**\n';
          }

          if (upcomingTasks.length > 0) {
            description += `\n\n📌 **TUGAS MENDATANG (48 JAM KE DEPAN):**\n`;
            description += upcomingTasks.map((t, idx) => {
              const badge = t.taskType === 'GROUP' ? '👥' : '👤';
              const dl = t.dueAt ? `<t:${Math.floor(t.dueAt.getTime() / 1000)}:R>` : '';
              return `• ${badge} **${t.title}** — Deadline: ${dl}`;
            }).join('\n');
          }

          description += '\n\n*Yuk cicil tugasmu dari sekarang agar tidak begadang malam nanti!* 🚀';
          embed.setDescription(description);
        }

        embed.setFooter({ text: 'TaskFlow OS • Daily Morning Briefing • Powered by Gemini AI' });

        await radarChannel.send({ embeds: [embed] });
        logger.info(`Morning briefing terkirim ke guild ${discordGuild.name}`);

        // Kirim DM pengingat personal ke user yang memiliki tugas hari ini
        for (const t of todayTasks) {
          const userIds = (t.taskType === 'GROUP' && t.assignedUserIds.length > 0)
            ? t.assignedUserIds
            : [t.userId];

          for (const uId of userIds) {
            try {
              const userObj = await prisma.user.findUnique({ where: { id: uId } }) || await prisma.user.findUnique({ where: { discordId: uId } });
              if (userObj) {
                const discUser = await client.users.fetch(userObj.discordId).catch(() => null);
                if (discUser) {
                  const dmEmbed = new EmbedBuilder()
                    .setTitle('☀️ Morning Digest: Tugasmu Hari Ini!')
                    .setDescription(
                      `Halo <@${discUser.id}>! Jangan lupa hari ini ada tugas:\n### **${t.title}**\n` +
                      `⏰ **Deadline:** <t:${Math.floor(t.dueAt!.getTime() / 1000)}:R> (<t:${Math.floor(t.dueAt!.getTime() / 1000)}:t>)\n` +
                      `🏷️ **Tipe:** ${t.taskType === 'GROUP' ? '👥 Tugas Kelompok' : '👤 Tugas Individu'}`
                    )
                    .setColor('#FFA500')
                    .setFooter({ text: 'Semangat produktif hari ini!' });

                  await discUser.send({ embeds: [dmEmbed] }).catch(() => null);
                }
              }
            } catch (err) {
              // Abaikan jika user mematikan DM
            }
          }
        }
      } catch (err) {
        logger.warn({ err, guildId: g.discordGuildId }, 'Gagal mengirim morning briefing ke guild');
      }
    }
  }

  /**
   * Menjalankan scheduler pengecekan jam 07:00 pagi WIB setiap hari
   */
  static startScheduler(client: Client) {
    logger.info('Scheduler Morning Briefing (07:00 WIB) diaktifkan.');

    setInterval(() => {
      // Ambil waktu WIB (UTC+7)
      const now = new Date();
      const utcHours = now.getUTCHours();
      const wibHours = (utcHours + 7) % 24;
      const todayStr = now.toISOString().slice(0, 10);

      // Cek apakah jam 07:00 WIB dan belum dikirim hari ini
      if (wibHours === 7 && this.lastBriefingDate !== todayStr) {
        this.lastBriefingDate = todayStr;
        this.sendMorningBriefing(client);
      }
    }, 60 * 1000); // Cek setiap 1 menit
  }
}
