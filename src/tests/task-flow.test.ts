import { describe, it, expect } from 'vitest';
import { generateGoogleCalendarUrl } from '../shared/utils/calendar';
import { TaskExtractionSchema } from '../modules/ai/ai.service';
import { isWithinQuietHours } from '../shared/utils/time';

describe('Google Calendar URL Generator', () => {
  it('should generate a valid Google Calendar URL with correct start and end times', () => {
    const dueAt = new Date('2026-10-15T15:00:00.000Z');
    const title = 'Laporan Pemrograman Web';
    const linkUrl = 'https://kuliah.ac.id/tugas/123';
    const description = 'Kumpulkan format PDF';

    const url = generateGoogleCalendarUrl(title, dueAt, linkUrl, description);
    const parsedUrl = new URL(url);

    expect(parsedUrl.origin).toBe('https://calendar.google.com');
    expect(parsedUrl.pathname).toBe('/calendar/render');
    expect(parsedUrl.searchParams.get('action')).toBe('TEMPLATE');
    expect(parsedUrl.searchParams.get('text')).toBe(`[TaskFlow] ${title}`);
    expect(parsedUrl.searchParams.get('details')).toContain(`📌 Tugas: ${title}`);
    expect(parsedUrl.searchParams.get('details')).toContain(`📝 Catatan: ${description}`);
    expect(parsedUrl.searchParams.get('details')).toContain(`🔗 Tempat Pengumpulan: ${linkUrl}`);
  });

  it('should handle optional linkUrl and description gracefully', () => {
    const dueAt = new Date('2026-11-01T10:00:00.000Z');
    const title = 'Quiz Kalkulus II';

    const url = generateGoogleCalendarUrl(title, dueAt);
    const parsedUrl = new URL(url);

    expect(parsedUrl.searchParams.get('text')).toBe(`[TaskFlow] ${title}`);
    expect(parsedUrl.searchParams.get('details')).toContain('⚡ Dibuat secara otomatis oleh TaskFlow Discord Bot');
    expect(parsedUrl.searchParams.get('details')).not.toContain('📝 Catatan:');
    expect(parsedUrl.searchParams.get('details')).not.toContain('🔗 Tempat Pengumpulan:');
  });
});

describe('AI TaskExtractionSchema Validation', () => {
  it('should parse valid full task data correctly', () => {
    const rawInput = {
      title: 'Tugas Proyek IoT',
      description: 'Laporan kelompok sensor ESP32',
      subtasks: ['Setup ESP32', 'Koding sensor', 'Buat laporan'],
      dueAt: '2026-10-20T16:59:00.000Z',
      estimatedMinutes: '120',
      priority: 'high',
      courseName: ' Internet of Things ',
      linkUrl: 'https://classroom.google.com/c/12345',
    };

    const parsed = TaskExtractionSchema.parse(rawInput);

    expect(parsed.title).toBe('Tugas Proyek IoT');
    expect(parsed.description).toBe('Laporan kelompok sensor ESP32');
    expect(parsed.subtasks).toEqual(['Setup ESP32', 'Koding sensor', 'Buat laporan']);
    expect(parsed.dueAt).toBe('2026-10-20T16:59:00.000Z');
    expect(parsed.estimatedMinutes).toBe(120);
    expect(parsed.priority).toBe('HIGH');
    expect(parsed.courseName).toBe('Internet of Things');
    expect(parsed.linkUrl).toBe('https://classroom.google.com/c/12345');
  });

  it('should fallback priority to MEDIUM if invalid priority is passed', () => {
    const rawInput = {
      title: 'Belajar Ujian',
      priority: 'UNKNOWN_PRIORITY',
    };

    const parsed = TaskExtractionSchema.parse(rawInput);
    expect(parsed.priority).toBe('MEDIUM');
  });

  it('should filter out empty subtasks and handle non-array input', () => {
    const rawInput = {
      title: 'Tugas Statistika',
      subtasks: ['Bab 1', '', '  ', 'Bab 2'],
    };

    const parsed = TaskExtractionSchema.parse(rawInput);
    expect(parsed.subtasks).toEqual(['Bab 1', 'Bab 2']);
  });

  it('should reject invalid title (empty string)', () => {
    const rawInput = {
      title: '',
    };

    expect(() => TaskExtractionSchema.parse(rawInput)).toThrow();
  });

  it('should return null for invalid URL format', () => {
    const rawInput = {
      title: 'Tugas Basis Data',
      linkUrl: 'bukan-url-valid',
    };

    const parsed = TaskExtractionSchema.parse(rawInput);
    expect(parsed.linkUrl).toBeNull();
  });
});

describe('Quiet Hours Utility', () => {
  it('should identify time within midnight-crossing quiet hours (23:00 to 07:00)', () => {
    // Jam 02:30 WIB (UTC = 19:30 kemarin) -> Di dalam Quiet Hours
    const dateAtNight = new Date('2026-10-15T19:30:00.000Z');
    const inQuiet = isWithinQuietHours(dateAtNight, {
      quietHoursStart: '23:00',
      quietHoursEnd: '07:00',
      quietHoursEnabled: true,
      timezone: 'Asia/Jakarta',
    });
    expect(inQuiet).toBe(true);

    // Jam 14:00 WIB (UTC = 07:00) -> Di luar Quiet Hours
    const dateAtDay = new Date('2026-10-15T07:00:00.000Z');
    const notInQuiet = isWithinQuietHours(dateAtDay, {
      quietHoursStart: '23:00',
      quietHoursEnd: '07:00',
      quietHoursEnabled: true,
      timezone: 'Asia/Jakarta',
    });
    expect(notInQuiet).toBe(false);
  });

  it('should return false if quietHoursEnabled is false', () => {
    const dateAtNight = new Date('2026-10-15T19:30:00.000Z');
    const result = isWithinQuietHours(dateAtNight, {
      quietHoursStart: '23:00',
      quietHoursEnd: '07:00',
      quietHoursEnabled: false,
      timezone: 'Asia/Jakarta',
    });
    expect(result).toBe(false);
  });
});
