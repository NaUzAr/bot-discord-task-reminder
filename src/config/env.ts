import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  BOT_TOKEN: z.string().min(1),
  CLIENT_ID: z.string().optional(),
  GUILD_ID: z.string().optional(),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),
  GEMINI_API_KEY: z.string().min(1),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().default(3000),
  DISCORD_CLIENT_SECRET: z.string().optional(),
  WEB_BASE_URL: z.string().default('http://localhost:3000'),
  ADMIN_DISCORD_IDS: z.string().optional(), // Comma-separated Discord IDs with ADMIN role
});

const parsedEnv = envSchema.safeParse(process.env);

if (!parsedEnv.success) {
  console.error('❌ Invalid environment variables:', parsedEnv.error.format());
  process.exit(1);
}

export const env = parsedEnv.data;
