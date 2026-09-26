import { env } from '../../config/env';
import { logger } from '../../shared/utils/logger';
import { z } from 'zod';

export const TaskExtractionSchema = z.object({
  title: z.string().min(1).max(200).describe("The clear, actionable title of the task."),
  dueAt: z.string().datetime().nullable().describe("The deadline in ISO 8601 UTC format. Null if no deadline is mentioned."),
  estimatedMinutes: z.number().int().positive().nullable().describe("Estimated duration in minutes. Null if not mentioned."),
  priority: z.enum(["LOW", "MEDIUM", "HIGH", "URGENT"]).describe("Priority based on urgency and context.")
});

export type ExtractedTask = z.infer<typeof TaskExtractionSchema>;

export class AIService {
  static async extractTask(userInput: string, timezone: string = 'Asia/Jakarta'): Promise<ExtractedTask | null> {
    const apiKey = env.GEMINI_API_KEY;
    const nowUTC = new Date().toISOString();

    const systemInstruction = `
You are an intelligent task parsing assistant for TaskFlow Discord Bot.
Your job is to extract task details from user messages (often in Indonesian slang).

Context Information:
- Current Server Time (UTC): ${nowUTC}
- User Local Timezone: ${timezone}

Rules:
1. Extract the core task title.
2. Determine the exact deadline (dueAt) in UTC ISO format based on the user's relative time (e.g., "besok malem jam 8"). Calculate this accurately based on the Current Server Time and User Local Timezone.
3. Determine estimated duration if mentioned (e.g., "2 jam" -> 120).
4. Guess the priority based on words like "urgent", "penting", "deadline mepet". Default to MEDIUM.
    `;

    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemInstruction }] },
          contents: [{ parts: [{ text: userInput }] }],
          generationConfig: { response_mime_type: "application/json" }
        })
      });

      if (!response.ok) {
         logger.error({ status: response.status }, 'Failed to fetch from Gemini API');
         return null;
      }

      const data = await response.json();
      const textOutput = data.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!textOutput) return null;

      const parsedJSON = JSON.parse(textOutput);
      return TaskExtractionSchema.parse(parsedJSON);
    } catch (error) {
      logger.error({ err: error }, 'AI Extraction failed');
      return null;
    }
  }
}
