import { format, subMinutes } from 'date-fns';

/**
 * Menghasilkan tautan Google Calendar 1-Click untuk menambahkan tugas ke kalender
 */
export function generateGoogleCalendarUrl(
  title: string,
  dueAt: Date,
  linkUrl?: string | null,
  description?: string | null
): string {
  // Start: 1 jam sebelum deadline, End: tepat pada waktu deadline
  const startDate = subMinutes(dueAt, 60);
  const startStr = format(startDate, "yyyyMMdd'T'HHmmss'Z'");
  const endStr = format(dueAt, "yyyyMMdd'T'HHmmss'Z'");

  const detailsText = [
    `📌 Tugas: ${title}`,
    description ? `📝 Catatan: ${description}` : '',
    linkUrl ? `🔗 Tempat Pengumpulan: ${linkUrl}` : '',
    '⚡ Dibuat secara otomatis oleh TaskFlow Discord Bot'
  ].filter(Boolean).join('\n\n');

  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `[TaskFlow] ${title}`,
    dates: `${startStr}/${endStr}`,
    details: detailsText
  });

  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
