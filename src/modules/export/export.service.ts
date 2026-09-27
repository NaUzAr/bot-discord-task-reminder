import { format } from 'date-fns';
import { id } from 'date-fns/locale';

export interface TaskExportItem {
  id: string;
  title: string;
  description?: string | null;
  dueAt: Date | null;
  priority: string;
  taskType?: string | null;
  courseId?: string | null;
  linkUrl?: string | null;
  status?: string;
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
        LOW: '🌱 LOW',
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

        if (t.courseId) {
          output += `• *Mata Kuliah:* ${t.courseId}\n`;
        }

        if (t.taskType === 'GROUP' && t.assignedUserIds && t.assignedUserIds.length > 0) {
          const members = t.assignedUserIds
            .map((uid) => {
              const userObj = discordClient?.users?.cache?.get(uid);
              return userObj ? `@${userObj.username}` : `@user`;
            })
            .join(', ');
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

  /**
   * Menghasilkan string file iCalendar (.ics) standar RFC 5545
   * Kompatibel penuh dengan Google Calendar, Apple Calendar, dan Outlook
   */
  static generateICalendar(tasks: TaskExportItem[], calendarName = 'TaskFlow OS Deadlines'): string {
    const toICSDate = (date: Date): string => {
      return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
    };

    const escapeICS = (str: string): string => {
      return str.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
    };

    const nowStr = toICSDate(new Date());

    let ics = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//TaskFlow OS//Intelligent Student Productivity//ID',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeICS(calendarName)}`,
      'X-WR-TIMEZONE:Asia/Jakarta',
    ];

    tasks.forEach((task) => {
      if (!task.dueAt) return; // Hanya tugas dengan deadline yang masuk ke kalender

      const dueDate = new Date(task.dueAt);
      // Durasi event default 1 jam sebelum deadline hingga batas waktu
      const startDate = new Date(dueDate.getTime() - 60 * 60 * 1000);

      const dtStamp = nowStr;
      const dtStart = toICSDate(startDate);
      const dtEnd = toICSDate(dueDate);
      const priorityNum = task.priority === 'URGENT' ? 1 : task.priority === 'HIGH' ? 3 : 5;

      const summary = `[${task.priority}] ${task.courseId ? `[${task.courseId}] ` : ''}${task.title}`;
      let description = task.description ? `${task.description}\n\n` : '';
      if (task.linkUrl) description += `Link: ${task.linkUrl}\n`;
      description += `Dikelola via TaskFlow OS`;

      ics.push(
        'BEGIN:VEVENT',
        `UID:${task.id}@taskflow.os`,
        `DTSTAMP:${dtStamp}`,
        `DTSTART:${dtStart}`,
        `DTEND:${dtEnd}`,
        `SUMMARY:${escapeICS(summary)}`,
        `DESCRIPTION:${escapeICS(description)}`,
        `PRIORITY:${priorityNum}`,
        'STATUS:CONFIRMED',
        'BEGIN:VALARM',
        'TRIGGER:-PT60M',
        'ACTION:DISPLAY',
        `DESCRIPTION:Pengingat Deadline 1 Jam: ${escapeICS(task.title)}`,
        'END:VALARM',
        'END:VEVENT'
      );
    });

    ics.push('END:VCALENDAR');
    return ics.join('\r\n');
  }

  /**
   * Menghasilkan string CSV untuk Excel dan Notion
   */
  static generateCSV(tasks: TaskExportItem[]): string {
    const escapeCSV = (str: string | null | undefined): string => {
      if (!str) return '""';
      return `"${str.replace(/"/g, '""')}"`;
    };

    const headers = ['ID', 'Judul', 'Mata Kuliah', 'Prioritas', 'Tipe', 'Status', 'Deadline', 'Link URL', 'Deskripsi'];
    const rows = tasks.map((t) => [
      escapeCSV(t.id),
      escapeCSV(t.title),
      escapeCSV(t.courseId || '-'),
      escapeCSV(t.priority),
      escapeCSV(t.taskType || 'INDIVIDUAL'),
      escapeCSV(t.status || 'TODO'),
      escapeCSV(t.dueAt ? new Date(t.dueAt).toISOString() : '-'),
      escapeCSV(t.linkUrl || '-'),
      escapeCSV(t.description || '-'),
    ]);

    return [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  }
}
