import { env } from '../../config/env';
import { logger } from '../../shared/utils/logger';
import { z } from 'zod';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const TaskExtractionSchema = z.object({
  title: z.string().min(1).max(200).describe("The clear, actionable title of the task."),
  description: z.string().nullable().optional().describe("Detailed specifications, guidelines, format instructions, or notes about the assignment."),
  subtasks: z.preprocess((val) => {
    if (Array.isArray(val)) {
      return val.map(item => String(item).trim()).filter(Boolean);
    }
    return [];
  }, z.array(z.string())).default([]).describe("List of subtasks, chapters, or checklist items extracted from format/instructions."),
  dueAt: z.preprocess((val) => {
    if (!val || typeof val !== 'string') return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }, z.string().datetime().nullable()).describe("The deadline in ISO 8601 UTC format. Null if no deadline is mentioned."),
  estimatedMinutes: z.preprocess((val) => {
    if (val === undefined || val === null || val === '') return null;
    if (typeof val === 'string') {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? null : parsed;
    }
    return val;
  }, z.number().int().positive().nullable().optional()).describe("Estimated duration in minutes. Null if not mentioned."),
  priority: z.preprocess((val) => {
    if (typeof val === 'string') {
      const upper = val.toUpperCase();
      if (['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(upper)) return upper;
    }
    return 'MEDIUM';
  }, z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"])).describe("Priority based on urgency and context."),
  courseName: z.preprocess((val) => {
    if (typeof val === 'string' && val.trim().length > 0) {
      return val.trim();
    }
    return null;
  }, z.string().nullable().optional()).describe("The academic course, subject, or lecture name (e.g. 'Kalkulus', 'Pemrograman Web', 'Sistem Pakar', 'Basis Data', 'AI'). Null if not course-related."),
  linkUrl: z.preprocess((val) => {
    if (!val || typeof val !== 'string') return null;
    try {
      const u = new URL(val);
      return u.toString();
    } catch {
      return null;
    }
  }, z.string().url().nullable().optional()).describe("Submission URL or assignment link if mentioned.")
});

export type ExtractedTask = z.infer<typeof TaskExtractionSchema>;

const genAI = new GoogleGenerativeAI(env.GEMINI_API_KEY);
const CANDIDATE_MODELS = [
  'gemini-3.5-flash-lite', // ⚡ Kuota Terbesar: 500 RPD, 15 RPM (Respon super cepat & irit)
  'gemini-3.1-flash-lite', // ⚡ Cadangan Lite: 500 RPD, 15 RPM
  'gemini-3.8-flash',      // 🛡️ Cadangan Flash 3.8: 20 RPD, 5 RPM
  'gemini-3.7-flash',      // 🛡️ Cadangan Flash 3.7: 20 RPD, 5 RPM
  'gemini-3.6-flash',      // 🛡️ Cadangan Flash 3.6: 20 RPD, 5 RPM
  'gemini-3-flash',        // 🛡️ Cadangan Flash 3: 20 RPD, 5 RPM
  'gemini-3.5-flash'       // 🛡️ Cadangan Terakhir
];

export class AIService {
  static async extractTask(userInput: string, timezone: string = 'Asia/Jakarta'): Promise<ExtractedTask | null> {
    const nowUTC = new Date().toISOString();

    const systemInstruction = `
You are an intelligent task parsing assistant for TaskFlow Discord Bot.
Your job is to extract task details from user messages in English or Indonesian.
Context:
- Current Server Time (UTC): ${nowUTC}
- User Local Timezone: ${timezone}

Rules:
1. Extract the core task title.
2. If the user message contains detailed instructions, specifications, format guidelines, or notes, extract them into "description" in clean readable markdown. Return null if none.
3. If the message lists steps, sub-sections, or checklist items (e.g. "1. Judul, 2. Pendahuluan..."), extract each item into the "subtasks" array so it can be tracked. Return empty array [] if none.
4. Determine exact deadline (dueAt) in ISO 8601 UTC format based on relative time (e.g. "besok jam 8 malam" or "lusa pagi"). Calculate from current server time and user timezone. Return null if no deadline is mentioned.
5. Determine estimated duration in minutes as an integer if mentioned (e.g. "2 jam" -> 120, "30 menit" -> 30). Return null if not mentioned.
6. Guess priority: strictly "LOW", "MEDIUM", "HIGH", or "URGENT". Default to "MEDIUM".
7. Extract submission link (linkUrl): if user mentions a URL (e.g. https://classroom.google.com/..., Google Drive, LMS, etc.), extract it. Return null if no link is mentioned.
8. Detect course, subject, or academic lecture name if available (e.g. "Kalkulus", "Pemrograman Web", "Sistem Pakar", "Fisika", "AI", "Statistika", "Basis Data", "Jaringan Komputer"). Return as clean capitalized title (e.g. "Kalkulus"). Return null if not mentioned or not related to a specific course.

Output strictly valid JSON with keys:
{
  "title": string,
  "courseName": string | null,
  "description": string | null,
  "subtasks": string[],
  "dueAt": string | null,
  "estimatedMinutes": number | null,
  "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT",
  "linkUrl": string | null
}
`;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ 
          model: modelName,
          systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
          }
        });

        const result = await model.generateContent(userInput);
        const textOutput = result.response.text();
        
        if (!textOutput) continue;

        const parsedJSON = JSON.parse(textOutput);
        const parsed = TaskExtractionSchema.parse(parsedJSON);

        // Regex fallback: Jika AI melewatkan URL, ambil URL pertama yang cocok di teks user
        if (!parsed.linkUrl) {
          const urlMatch = userInput.match(/https?:\/\/[^\s]+/i);
          if (urlMatch) {
            try {
              parsed.linkUrl = new URL(urlMatch[0]).toString();
            } catch {}
          }
        }

        return parsed;
      } catch (error: any) {
        logger.warn({ model: modelName, err: error?.message || error }, 'AI model attempt failed, trying fallback if available');
      }
    }

    logger.error('All AI models failed to extract task');
    return null;
  }

  static async extractTaskFromImage(
    imageBuffer: Buffer,
    mimeType: string,
    caption?: string,
    timezone: string = 'Asia/Jakarta'
  ): Promise<ExtractedTask | null> {
    const nowUTC = new Date().toISOString();

    const systemInstruction = `
You are an intelligent multimodal vision task parsing assistant for TaskFlow Discord Bot.
Your job is to read and understand assignment details from images (e.g. presentation slides, document screenshots, format requirements, syllabus, WhatsApp chat screenshots, handwritten notes, or LMS screenshots) and optional user captions in English or Indonesian.
Context:
- Current Server Time (UTC): ${nowUTC}
- User Local Timezone: ${timezone}

Rules:
1. Carefully read and OCR all text, instructions, format specifications, and dates from the image.
2. If the user provided a caption, use it to understand additional context (e.g. subject name or specific instructions).
3. Extract the core task title (e.g. "Makalah Pemrograman R", "Laporan Praktikum Fisika", "Tugas Makalah").
4. Extract detailed specifications, formatting rules, or notes into "description" (e.g. if the image specifies paper format, outline, font, or instructions).
5. If the image contains a list of steps, chapters, paper structure, or requirements (such as:
   "Format makalah:
   1. Judul
   2. Pendahuluan
   3. Teori singkat
   4. Koding/skrip program R
   5. Hasil dan Pembahasan
   6. Simpulan dan saran
   7. Referensi
   8. Lampiran (print out)"),
   extract these individual items into the "subtasks" array so they can become an interactive checklist!
6. Determine exact deadline (dueAt) in ISO 8601 UTC format. Calculate from current server time and user timezone. Return null if no deadline is found.
7. Determine estimated duration in minutes if mentioned. Return null if not found.
8. Determine priority: strictly "LOW", "MEDIUM", "HIGH", or "URGENT". Default to "MEDIUM" (or "HIGH" if deadline is within 24h).
9. Extract submission link (linkUrl) if any URL is visible in the image or caption. Return null if not mentioned.
10. Detect course or subject name if visible in the slide/document header or body (e.g. "Kalkulus", "Pemrograman Web", "Sistem Pakar", "Statistika", "AI", "Basis Data"). Return as clean capitalized title (e.g. "Kalkulus"). Return null if not mentioned.

Output strictly valid JSON with keys:
{
  "title": string,
  "courseName": string | null,
  "description": string | null,
  "subtasks": string[],
  "dueAt": string | null,
  "estimatedMinutes": number | null,
  "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT",
  "linkUrl": string | null
}
`;

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString("base64"),
        mimeType: mimeType || "image/png"
      }
    };

    const promptText = caption && caption.trim().length > 0 
      ? `User caption: "${caption}". Extract the task details, format, outline, and checklist from this image.`
      : "Extract the task details, title, format specification, subtasks/checklist, deadline, and links from this image.";

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
          }
        });

        const result = await model.generateContent([promptText, imagePart]);
        const textOutput = result.response.text();
        if (!textOutput) continue;

        const parsedJSON = JSON.parse(textOutput);
        const parsed = TaskExtractionSchema.parse(parsedJSON);

        // Fallback jika ada URL di caption
        if (!parsed.linkUrl && caption) {
          const urlMatch = caption.match(/https?:\/\/[^\s<]+[^<.,:;"')\]\s]/);
          if (urlMatch) {
            try {
              parsed.linkUrl = new URL(urlMatch[0]).toString();
            } catch {}
          }
        }

        logger.info({ modelName, parsed }, 'Sukses mengekstrak task dari gambar dengan Gemini Vision');
        return parsed;
      } catch (error: any) {
        logger.warn({ model: modelName, err: error?.message || error }, 'Model gagal ekstrak task dari gambar, mencoba fallback...');
      }
    }

    logger.error('Semua model Gemini gagal mengekstrak task dari gambar.');
    return null;
  }

  static async extractTaskFromAudio(
    audioBuffer: Buffer,
    mimeType: string,
    caption?: string,
    timezone: string = 'Asia/Jakarta'
  ): Promise<ExtractedTask | null> {
    const nowUTC = new Date().toISOString();

    const systemInstruction = `
You are an intelligent multimodal audio task parsing assistant for TaskFlow Discord Bot.
Your job is to listen to voice messages or audio recordings in Indonesian or English and extract actionable task details.
Context:
- Current Server Time (UTC): ${nowUTC}
- User Local Timezone: ${timezone}

Rules:
1. Carefully listen to and transcribe the speech in the audio.
2. If the user provided a caption, combine it with the voice content.
3. Extract the core task title.
4. If instructions, notes, or format guidelines are mentioned, extract them into "description". Return null if none.
5. If subtasks or steps are mentioned, extract them into "subtasks" array. Return empty array [] if none.
6. Determine exact deadline (dueAt) in ISO 8601 UTC format. Calculate from current server time and user timezone. Return null if no deadline is mentioned.
7. Determine estimated duration in minutes if mentioned. Return null if not found.
8. Determine priority: strictly "LOW", "MEDIUM", "HIGH", or "URGENT". Default to "MEDIUM".
9. Extract submission link (linkUrl) if any URL is spoken or written in caption. Return null if not mentioned.

Output strictly valid JSON with keys:
{
  "title": string,
  "description": string | null,
  "subtasks": string[],
  "dueAt": string | null,
  "estimatedMinutes": number | null,
  "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT",
  "linkUrl": string | null
}
`;

    const audioPart = {
      inlineData: {
        data: audioBuffer.toString("base64"),
        mimeType: mimeType || "audio/ogg"
      }
    };

    const promptText = caption && caption.trim().length > 0
      ? `User caption: "${caption}". Listen to this audio and extract task details.`
      : "Listen carefully to this voice message and extract task details, title, deadline, and priority.";

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: {
            responseMimeType: "application/json",
          }
        });

        const result = await model.generateContent([promptText, audioPart]);
        const textOutput = result.response.text();
        if (!textOutput) continue;

        const parsedJSON = JSON.parse(textOutput);
        const parsed = TaskExtractionSchema.parse(parsedJSON);

        logger.info({ modelName, parsed }, 'Sukses mengekstrak task dari audio/voice note dengan Gemini');
        return parsed;
      } catch (error: any) {
        logger.warn({ model: modelName, err: error?.message || error }, 'Model gagal ekstrak task dari audio, mencoba fallback...');
      }
    }

    logger.error('Semua model Gemini gagal mengekstrak task dari audio.');
    return null;
  }

  static async breakdownTask(taskTitle: string): Promise<string[]> {
    const prompt = `
Sebagai asisten produktivitas, pecahkan tugas berikut menjadi 4 sampai 5 sub-tugas (actionable checklist) yang konkret, praktis, dan mudah dicicil oleh mahasiswa/pekerja:
Tugas: "${taskTitle}"

Keluarkan HANYA JSON array berisi string sub-tugas, contoh:
["Cari 3 bahan referensi jurnal", "Tulis draf metodologi", "Kerjakan analisis data", "Buat kesimpulan", "Review dan format akhir"]
`;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          generationConfig: {
            responseMimeType: "application/json"
          }
        });

        const result = await model.generateContent(prompt);
        const textOutput = result.response.text();
        if (!textOutput) continue;

        const parsed = JSON.parse(textOutput);
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
          return parsed.slice(0, 5);
        }
      } catch (error: any) {
        logger.warn({ model: modelName, err: error?.message || error }, 'AI breakdown attempt failed, trying fallback');
      }
    }

    return [
      `Persiapan bahan untuk ${taskTitle}`,
      `Pengerjaan bagian utama ${taskTitle}`,
      `Review dan pengecekan hasil`,
      `Submit / selesaikan ${taskTitle}`
    ];
  }

  /**
   * 🧠 AI Daily Planner & Time-Blocking Generator
   * Menganalisis daftar tugas aktif dan waktu luang untuk membuat jadwal eksekusi Pomodoro yang realistis
   */
  static async generateStudyPlan(
    tasks: { title: string; priority: string; dueAt: Date | null; estimatedMinutes: number | null; description?: string | null }[],
    timeframe: string = 'Malam ini (3-4 jam)',
    timezone: string = 'Asia/Jakarta'
  ): Promise<string> {
    const taskSummary = tasks.map((t, idx) => {
      const dl = t.dueAt ? t.dueAt.toLocaleString('id-ID', { timeZone: timezone }) : 'Tanpa deadline';
      const est = t.estimatedMinutes ? `${t.estimatedMinutes} menit` : 'belum ada estimasi';
      return `${idx + 1}. "${t.title}" | Prioritas: ${t.priority} | Deadline: ${dl} | Estimasi: ${est}`;
    }).join('\n');

    const prompt = `
Kamu adalah AI Executive Productivity & Study Coach kelas dunia untuk bot Discord TaskFlow.
Bantu mahasiswa/pekerja ini menyusun rencana time-blocking dan urutan pengerjaan tugas yang sangat realistis, terstruktur, dan memotivasi.

Daftar Tugas Aktif:
${taskSummary}

Ketersediaan Waktu / Sesi Belajar:
"${timeframe}"

Instruksi:
1. Urutkan tugas berdasarkan metode Eisenhower (Prioritas URGENT/HIGH dan deadline terdekat didahulukan).
2. Buat pembagian blok waktu (Time-Blocking) menggunakan teknik Pomodoro (blok 25-50 menit kerja + jeda istirahat 5-15 menit).
3. Berikan "🎯 First Focus Target" (tugas spesifik pertama yang harus diserang sekarang).
4. Berikan tips singkat anti-prokrastinasi yang menyemangati.
5. Format dalam Markdown Discord yang sangat rapi dan enak dibaca dengan bullet points dan emoji.
`;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (text && text.trim().length > 0) return text.trim();
      } catch (err: any) {
        logger.warn({ model: modelName, err: err?.message || err }, 'Gagal generate study plan, trying fallback...');
      }
    }

    return `### 🧠 Rencana Belajar Cepat\n\n` +
      `• **🎯 Fokus Pertama:** Selesaikan tugas prioritas tertinggi selama 25-50 menit.\n` +
      `• **☕ Jeda:** Istirahat santai 5-10 menit tanpa membuka medsos.\n` +
      `• **🚀 Lanjutan:** Cicil checklist sub-tugas berikutnya.\n\n` +
      `*Tekan tombol Fokus di bawah untuk langsung mengaktifkan timer!*`;
  }

  /**
   * ⚠️ AI Workload & Anti-Burnout Advisory
   * Menganalisis beban waktu tugas hari ini vs kapasitas waktu luang
   */
  static async generateWorkloadAdvice(
    tasks: { title: string; priority: string; dueAt: Date | null; estimatedMinutes: number | null }[],
    totalMinutes: number,
    availableMinutes: number = 300 // default 5 jam
  ): Promise<string> {
    const hours = Math.floor(totalMinutes / 60);
    const mins = totalMinutes % 60;
    const availHours = Math.floor(availableMinutes / 60);

    const taskList = tasks.map((t, i) => `${i + 1}. "${t.title}" (${t.priority}, est: ${t.estimatedMinutes || 60}m)`).join('\n');

    const prompt = `
Kamu adalah AI Executive Academic Advisor untuk bot Discord TaskFlow.
Tugasmu adalah menganalisis beban belajar mahasiswa hari ini dan memberikan saran manajemen energi & waktu yang cerdas dan anti-burnout.

Data Beban Hari Ini:
- Total Tugas: ${tasks.length} tugas
- Total Estimasi Waktu Diperlukan: ${hours} Jam ${mins} Menit (${totalMinutes} Menit)
- Kapasitas Belajar Harian Sehat: ${availHours} Jam (${availableMinutes} Menit)
- Status: ${totalMinutes > availableMinutes ? '⚠️ OVERLOAD (Beban melebihi kapasitas waktu)' : '✅ MANAGEABLE (Kapasitas cukup)'}

Daftar Tugas:
${taskList}

Instruksi:
1. Berikan evaluasi cepat (1-2 kalimat) apakah kondisi ini berisiko membuat burnout.
2. Jika OVERLOAD: Tentukan strategi eliminasi/penundaan (mana tugas yang HARUS dikerjakan hari ini vs mana yang bisa di-snooze / dicicil besok).
3. Jika MANAGEABLE: Berikan urutan eksekusi paling efisien (Eat the Frog / Peak Energy hours).
4. Berikan 1 tips actionable pencegahan prokrastinasi.
5. Format dalam Markdown Discord yang sangat ringkas, padat, dan memotivasi dengan emoji.
`;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (text && text.trim().length > 0) return text.trim();
      } catch (err: any) {
        logger.warn({ model: modelName, err: err?.message || err }, 'Gagal generate workload advice, trying fallback...');
      }
    }

    if (totalMinutes > availableMinutes) {
      return `⚠️ **Saran Cepat AI:** Beban belajarmu hari ini (${hours}h ${mins}m) cukup padat. Fokus selesaikan 1-2 tugas prioritas tinggi terlebih dahulu, dan pertimbangkan untuk menunda tugas prioritas rendah ke esok hari agar tidak burnout! ☕`;
    }
    return `✅ **Saran Cepat AI:** Beban tugas hari ini aman dan seimbang. Manfaatkan sesi Pomodoro 25 menit untuk menyelesaikan tugas secara bertahap! 🚀`;
  }

  /**
   * 📊 AI Weekly Productivity Review & Coaching
   * Menganalisis performa 7 hari ke belakang dan memberikan rekomendasi kebiasaan belajar
   */
  static async generateWeeklyReview(
    completedTasks: { title: string; priority: string; estimatedMinutes?: number | null }[],
    overdueTasks: { title: string; priority: string }[],
    totalFocusMinutes: number,
    accuracyScore: number
  ): Promise<string> {
    const focusHours = (totalFocusMinutes / 60).toFixed(1);
    const completedList = completedTasks.slice(0, 8).map(t => `- ${t.title} (${t.priority})`).join('\n') || 'Belum ada tugas selesai minggu ini';
    const overdueList = overdueTasks.slice(0, 5).map(t => `- ${t.title} (${t.priority})`).join('\n') || 'Nihil (Semua beres tepat waktu!)';

    const prompt = `
Kamu adalah AI Performance & Productivity Coach kelas dunia untuk mahasiswa/pekerja.
Analisis performa mingguan pengguna selama 7 hari terakhir:

Statistik:
- Tugas Diselesaikan: ${completedTasks.length} tugas
- Tugas Terlewat / Overdue: ${overdueTasks.length} tugas
- Total Waktu Fokus Pomodoro: ${focusHours} Jam (${totalFocusMinutes} Menit)
- Akurasi Estimasi Waktu: ${accuracyScore}%

Daftar Tugas Selesai:
${completedList}

Daftar Tugas Overdue / Tertunda:
${overdueList}

Instruksi:
1. Berikan apresiasi atau evaluasi jujur tentang kedisiplinan dan ritme belajarnya minggu ini.
2. Sorot pencapaian positif (misal konsistensi jam fokus atau keberhasilan menuntaskan tugas).
3. Analisis kelemahan (misal: jika ada tugas tertunda, apa penyebab potensialnya dan bagaimana memperbaikinya).
4. Berikan "🎯 1 Target Kunci Minggu Depan".
5. Gunakan bahasa Indonesia yang bersahabat, cerdas, tidak kaku, dan memotivasi. Format dengan Markdown Discord ringkas.
`;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (text && text.trim().length > 0) return text.trim();
      } catch (err: any) {
        logger.warn({ model: modelName, err: err?.message || err }, 'Gagal generate weekly review, trying fallback...');
      }
    }

    return `### 🌟 Evaluasi Produktivitas Mingguan\n\n` +
      `Kerja bagus minggu ini! Kamu telah menyelesaikan **${completedTasks.length} tugas** dengan total waktu fokus **${focusHours} jam**.\n\n` +
      `• **💡 Rekomendasi:** Pertahankan ritme belajarmu dengan memecah tugas besar menjadi sub-tugas kecil sejak hari pertama tugas diberikan.\n` +
      `• **🎯 Target Minggu Depan:** Tingkatkan durasi Deep Work dan selesaikan tugas sebelum H-1 deadline! 🚀`;
  }

  /**
   * 💬 AI Natural Language Query Assistant
   * Menjawab pertanyaan santai pengguna tentang tugas, deadline, dan progres berdasarkan database tugas
   */
  static async answerTaskQuery(
    query: string,
    tasks: {
      id: string;
      title: string;
      taskType: string;
      priority: string;
      status: string;
      dueAt: Date | null;
      courseId?: string | null;
      assignedUserIds?: string[];
      description?: string | null;
      subtasks?: { title: string; status: string }[];
    }[],
    userStats?: { username: string; xp: number; level: number; streak: number; totalFocusMinutes: number } | null,
    timezone: string = 'Asia/Jakarta'
  ): Promise<string> {
    const nowLocal = new Date().toLocaleString('id-ID', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' });

    const formattedTasks = tasks.map((t, i) => {
      const dl = t.dueAt 
        ? t.dueAt.toLocaleString('id-ID', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' })
        : 'Tanpa deadline';
      const typeStr = t.taskType === 'GROUP' ? '👥 Tugas Kelompok' : '👤 Tugas Individu';
      const course = t.courseId ? ` [Matkul: ${t.courseId}]` : '';
      const sub = t.subtasks && t.subtasks.length > 0 
        ? `\n   Subtasks: ` + t.subtasks.map(s => `${s.status === 'DONE' ? '✅' : '⬜'} ${s.title}`).join(', ')
        : '';
      return `${i + 1}. "${t.title}" (${typeStr}${course}) | Status: ${t.status} | Deadline: ${dl} | Prioritas: ${t.priority}${sub}`;
    }).join('\n') || 'Tidak ada tugas yang tercatat saat ini.';

    const statsInfo = userStats
      ? `User: ${userStats.username} | Level: ${userStats.level} | XP: ${userStats.xp} | Streak: ${userStats.streak} hari | Total Jam Fokus: ${(userStats.totalFocusMinutes / 60).toFixed(1)} jam`
      : 'User belum memiliki catatan fokus.';

    const prompt = `
Kamu adalah TaskFlow AI Assistant — asisten cerdas, santai, dan sangat membantu di server Discord.
Kamu memiliki akses langsung ke database tugas dan produktivitas pengguna saat ini.

Waktu Saat Ini: ${nowLocal} (WIB)
Profil Pengguna:
${statsInfo}

Data Tugas Pengguna (Aktif & Terjadwal):
${formattedTasks}

Pertanyaan Pengguna:
"${query}"

Instruksi:
1. Jawab pertanyaan pengguna secara akurat, lugas, dan relevan berdasarkan data tugas di atas.
2. Gunakan gaya bahasa Indonesia yang kasual, cerdas, bersahabat, dan memotivasi (seperti teman belajar yang suportif).
3. Jika ditanya tentang tugas paling mendesak/mepet, sebutkan nama tugas, deadline, dan rekomendasikan untuk segera dikerjakan.
4. Jika ditanya tentang tugas kelompok, jelaskan siapa saja anggota atau progres sub-tugas yang belum selesai.
5. Format jawaban dengan Markdown Discord (bullet points, bold, emoji) agar rapi, menarik, dan enak dibaca sekilas.
6. Buat jawaban padat dan ringkas (tidak bertele-tele, maksimal 2-3 paragraf/poin).
`;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({ model: modelName });
        const result = await model.generateContent(prompt);
        const text = result.response.text();
        if (text && text.trim().length > 0) return text.trim();
      } catch (err: any) {
        logger.warn({ model: modelName, err: err?.message || err }, 'Gagal menjawab task query, trying fallback...');
      }
    }

    return `Maaf, aku sedang kesulitan menganalisis datamu saat ini. Coba cek tugas aktifmu langsung dengan perintah \`/tasks\` atau \`/today\` ya! ☕`;
  }

  /**
   * 🔁 Extract Recurring Task dari input bahasa alami
   * Contoh: "Jurnal praktikum fisika setiap Jumat jam 23:59"
   */
  static async extractRecurringTask(userInput: string, timezone: string = 'Asia/Jakarta'): Promise<{
    title: string;
    courseName: string | null;
    description: string | null;
    subtasks: string[];
    linkUrl: string | null;
    priority: string;
    repeatPattern: string; // "DAILY" | "WEEKLY" | "BIWEEKLY"
    dayOfWeek: number | null; // 0=Minggu, 1=Senin, ..., 6=Sabtu
    deadlineHour: number; // Jam deadline dalam timezone user (0-23)
    deadlineMinute: number; // Menit deadline (0-59)
  } | null> {
    const nowUTC = new Date().toISOString();

    const systemInstruction = `
You are a recurring task parser for TaskFlow Discord Bot.
Your job is to extract repeating/recurring task details from Indonesian or English user messages.

Context:
- Current UTC: ${nowUTC}
- User Timezone: ${timezone}

Rules:
1. Extract the task title (what is being repeated).
2. Detect the repeat pattern:
   - "setiap hari" / "daily" → "DAILY"
   - "setiap minggu" / "tiap minggu" / "mingguan" / "setiap [hari]" → "WEEKLY"
   - "setiap 2 minggu" / "2 mingguan" → "BIWEEKLY"
3. Detect the day of week (for WEEKLY/BIWEEKLY):
   - Minggu=0, Senin=1, Selasa=2, Rabu=3, Kamis=4, Jumat=5, Sabtu=6
   - null for DAILY
4. Detect the deadline time in the USER'S LOCAL TIMEZONE (${timezone}):
   - "jam 23:59" → deadlineHour=23, deadlineMinute=59
   - "jam 8 malam" → deadlineHour=20, deadlineMinute=0
   - If no time mentioned, default to deadlineHour=23, deadlineMinute=59
5. Detect academic course name if mentioned (e.g. "Fisika", "Kalkulus", "AI").
6. Detect subtasks/checklist if mentioned.
7. Detect submission link if mentioned.
8. Guess priority (default "MEDIUM").

Output strictly valid JSON:
{
  "title": string,
  "courseName": string | null,
  "description": string | null,
  "subtasks": string[],
  "linkUrl": string | null,
  "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT",
  "repeatPattern": "DAILY" | "WEEKLY" | "BIWEEKLY",
  "dayOfWeek": number | null,
  "deadlineHour": number,
  "deadlineMinute": number
}
`;

    for (const modelName of CANDIDATE_MODELS) {
      try {
        const model = genAI.getGenerativeModel({
          model: modelName,
          systemInstruction,
          generationConfig: { responseMimeType: "application/json" }
        });

        const result = await model.generateContent(userInput);
        const textOutput = result.response.text();
        if (!textOutput) continue;

        const parsed = JSON.parse(textOutput);

        // Validasi minimal
        if (!parsed.title || !parsed.repeatPattern) continue;
        if (!['DAILY', 'WEEKLY', 'BIWEEKLY'].includes(parsed.repeatPattern)) {
          parsed.repeatPattern = 'WEEKLY';
        }
        if (parsed.dayOfWeek !== null && (parsed.dayOfWeek < 0 || parsed.dayOfWeek > 6)) {
          parsed.dayOfWeek = null;
        }
        parsed.deadlineHour = typeof parsed.deadlineHour === 'number' ? Math.min(23, Math.max(0, parsed.deadlineHour)) : 23;
        parsed.deadlineMinute = typeof parsed.deadlineMinute === 'number' ? Math.min(59, Math.max(0, parsed.deadlineMinute)) : 59;
        parsed.subtasks = Array.isArray(parsed.subtasks) ? parsed.subtasks : [];
        parsed.priority = ['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(parsed.priority) ? parsed.priority : 'MEDIUM';

        return parsed;
      } catch (err: any) {
        logger.warn({ model: modelName, err: err?.message || err }, 'Gagal parse recurring task, trying fallback...');
      }
    }
    return null;
  }
}


