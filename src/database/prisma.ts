import { PrismaClient } from '@prisma/client';
import { env } from '../config/env';

export const prisma = new PrismaClient({
  log: env.LOG_LEVEL === 'debug' ? ['query', 'error', 'warn'] : ['error'],
});
