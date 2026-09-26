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
  }, z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"])).describe("Priority based on urgency and context.")
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

Output strictly valid JSON with keys:
{
  "title": string,
  "dueAt": string | null,
  "estimatedMinutes": number | null,
  "priority": "LOW" | "MEDIUM" | "HIGH" | "URGENT"
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
        return TaskExtractionSchema.parse(parsedJSON);
      } catch (error: any) {
        logger.warn({ model: modelName, err: error?.message || error }, 'AI model attempt failed, trying fallback if available');
      }
    }

    logger.error('All AI models failed to extract task');
    return null;
  }
}
