import { env } from '../../config/env';
import { logger } from '../../shared/utils/logger';
import { z } from 'zod';
import { GoogleGenerativeAI } from '@google/generative-ai';

export const TaskExtractionSchema = z.object({
  title: z.string().min(1).max(200).describe("The clear, actionable title of the task."),
  dueAt: z.preprocess((val) => {
    if (!val || typeof val !== 'string') return null;
    const d = new Date(val);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }, z.string().datetime().nullable()).describe("The deadline in ISO 8601 UTC format. Null if no deadline is mentioned."),
  estimatedMinutes: z.preprocess((val) => {
    if (typeof val === 'string') {
      const parsed = parseInt(val, 10);
      return isNaN(parsed) ? null : parsed;
    }
    return val;
  }, z.number().int().positive().nullable()).describe("Estimated duration in minutes. Null if not mentioned."),
  priority: z.preprocess((val) => {
    if (typeof val === 'string') {
      const upper = val.toUpperCase();
      if (['LOW', 'MEDIUM', 'HIGH', 'URGENT'].includes(upper)) return upper;
    }
    return 'MEDIUM';
  }, z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"])).describe("Priority based on urgency and context."),
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
const CANDIDATE_MODELS = ['gemini-3.5-flash', 'gemini-3.8-flash'];

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
2. Determine exact deadline (dueAt) in ISO 8601 UTC format based on relative time (e.g. "besok jam 8 malam" or "lusa pagi"). Calculate from current server time and user timezone. Return null if no deadline is mentioned.
3. Determine estimated duration in minutes as an integer if mentioned (e.g. "2 jam" -> 120, "30 menit" -> 30). Return null if not mentioned.
4. Guess priority: strictly "LOW", "MEDIUM", "HIGH", or "URGENT". Default to "MEDIUM".
5. Extract submission link (linkUrl): if user mentions a URL (e.g. https://classroom.google.com/..., Google Drive, LMS, etc.), extract it. Return null if no link is mentioned.

Output strictly valid JSON with keys:
{
  "title": string,
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
}
