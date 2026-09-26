import { format } from 'date-fns';
import { id } from 'date-fns/locale';

interface TaskExportItem {
  id: string;
  title: string;
  dueAt: Date | null;
  priority: string;
  taskType?: string | null;
  linkUrl?: string | null;
  assignedUserIds?: string[];
  user?: { username: string; discordId: string };
}

export class ExportService {
  /**
   * Menghasilkan teks dengan format markdown WhatsApp yang siap langsung di-copas
   */
  static formatWhatsAppRekap(
    tasks: TaskExportItem[],
    scopeName: string = 'SERVER',
    discordClient?: any
  ): string {
    const now = new Date();
    // Format tanggal Indonesia
    const nowStr = format(now, "EEEE, d MMMM yyyy 'pukul' HH:mm 'WIB'", { locale: id });

    let output = `📋 *REKAP TUGAS & DEADLINE (${scopeName.toUpperCase()})* 📋\n`;
    output += `_Diperbarui: ${nowStr}_\n`;
    output += `_Dikelola otomatis via TaskFlow Discord Bot_\n`;
    output += `━━━━━━━━━━━━━━━━━━━━━\n\n`;

    if (tasks.length === 0) {
      output += `🎉 *Alhamdulillah, semua tugas sudah selesai!*\n`;
      output += `Tidak ada tanggungan tugas atau deadline aktif saat ini. Waktunya istirahat! ☕\n\n`;
    } else {
      const priorityEmoji: Record<string, string> = {
        URGENT: '🚨 URGENT',
        HIGH: '🔥 HIGH',
        MEDIUM: '⚡ MEDIUM',
        LOW: '🌱 LOW'
      };

      tasks.forEach((t, idx) => {
        const typeBadge = t.taskType === 'GROUP' ? '👥 [Kelompok]' : '👤 [Individu]';
        const pStr = priorityEmoji[t.priority] || '⚡ MEDIUM';
        
        let dlStr = 'Tanpa batas waktu';
        if (t.dueAt) {
          dlStr = format(new Date(t.dueAt), "EEEE, d MMM yyyy (HH:mm 'WIB')", { locale: id });
        }

        output += `*${idx + 1}. ${typeBadge} ${t.title}*\n`;
        output += `• *Deadline:* ${dlStr}\n`;
        output += `• *Prioritas:* ${pStr}\n`;

        if (t.taskType === 'GROUP' && t.assignedUserIds && t.assignedUserIds.length > 0) {
          const members = t.assignedUserIds.map(uid => {
            const userObj = discordClient?.users?.cache?.get(uid);
            return userObj ? `@${userObj.username}` : `@user`;
          }).join(', ');
          output += `• *Anggota Tim:* ${members}\n`;
        } else if (t.user?.username) {
          output += `• *Pembuat:* @${t.user.username}\n`;
        }

        if (t.linkUrl) {
          output += `• *Link Tugas:* ${t.linkUrl}\n`;
        }

        output += `\n`;
      });
    }

    output += `━━━━━━━━━━━━━━━━━━━━━\n`;
    output += `_Total: ${tasks.length} Tugas Aktif_\n`;
    output += `_Yuk saling mengingatkan & jangan mepet deadline ya! 🚀_`;

    return output;
  }
}
