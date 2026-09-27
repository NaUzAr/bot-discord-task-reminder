/**
 * 🌙 Time & Quiet Hours Utility
 * Menangani evaluasi jam tenang (Quiet Hours) dan penyesuaian zona waktu secara akurat.
 */

export interface QuietHoursConfig {
  quietHoursStart: string; // Format "HH:mm", e.g. "23:00"
  quietHoursEnd: string;   // Format "HH:mm", e.g. "07:00"
  quietHoursEnabled: boolean;
  timezone?: string;       // e.g. "Asia/Jakarta"
}

/**
 * Mendapatkan komponen jam dan menit saat ini pada zona waktu tertentu.
 */
export function getTimeComponentsInTimezone(date: Date, timezone: string = 'Asia/Jakarta'): { hours: number; minutes: number; timeString: string } {
  try {
    const formatter = new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(date);
    const hours = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const minutes = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return { hours, minutes, timeString };
  } catch {
    // Fallback ke UTC jika timezone invalid
    const hours = date.getUTCHours();
    const minutes = date.getUTCMinutes();
    const timeString = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    return { hours, minutes, timeString };
  }
}

/**
 * Memeriksa apakah saat ini berada dalam rentang jam tenang (Quiet Hours).
 */
export function isWithinQuietHours(
  now: Date,
  config: QuietHoursConfig
): boolean {
  if (!config.quietHoursEnabled) return false;

  const timezone = config.timezone || 'Asia/Jakarta';
  const { timeString } = getTimeComponentsInTimezone(now, timezone);

  const start = config.quietHoursStart.trim();
  const end = config.quietHoursEnd.trim();

  if (start === end) return false;

  if (start > end) {
    // Melewati tengah malam (misal 23:00 s/d 07:00)
    return timeString >= start || timeString < end;
  } else {
    // Dalam hari yang sama (misal 13:00 s/d 15:00)
    return timeString >= start && timeString < end;
  }
}

/**
 * Menghitung waktu (Date) saat jam tenang berikutnya berakhir.
 * Digunakan untuk menjadwalkan ulang reminder yang tertahan selama jam tidur.
 */
export function calculateNextQuietHoursEndTime(
  now: Date,
  config: QuietHoursConfig
): Date {
  const timezone = config.timezone || 'Asia/Jakarta';
  const [endHours, endMinutes] = config.quietHoursEnd.split(':').map(n => parseInt(n, 10));

  // Ambil tanggal lokal hari ini di zona waktu target
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const localDateStr = formatter.format(now); // "YYYY-MM-DD"

  // Buat kandidat tanggal akhir jam tenang untuk hari ini
  // Kita gunakan pergeseran timezone offset
  const todayEnd = new Date(`${localDateStr}T${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}:00`);

  // Jika waktu sekarang sudah melewati jam bangun hari ini, berarti jam bangun berikutnya adalah besok
  if (now.getTime() >= todayEnd.getTime()) {
    // Tambah 1 hari
    const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const tomorrowDateStr = formatter.format(tomorrow);
    return new Date(`${tomorrowDateStr}T${String(endHours).padStart(2, '0')}:${String(endMinutes).padStart(2, '0')}:00`);
  }

  return todayEnd;
}
