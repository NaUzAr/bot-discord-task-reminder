import crypto from 'crypto';
import Redis from 'ioredis';
import { env } from '../../config/env';
import { logger } from '../../shared/utils/logger';
import { generateInitialsAvatar } from '../../shared/utils/avatar';

export interface CachedUserSession {
  token: string;
  userId: string;
  discordId: string;
  username: string;
  role: 'USER' | 'ADMIN';
  avatarUrl: string;
  rememberMe: boolean;
  createdAt: number;
  expiresAt: number;
}

export interface CacheStats {
  totalCachedInMemory: number;
  redisConnected: boolean;
  hits: number;
  misses: number;
  hitRatePercent: number;
}

class SessionCacheService {
  private memoryCache = new Map<string, CachedUserSession>();
  private redisClient: Redis | null = null;
  private isRedisReady = false;
  private hits = 0;
  private misses = 0;

  constructor() {
    this.initRedis();
    // Jalankan pembersihan berkala untuk token kedaluwarsa di memori tiap 10 menit
    setInterval(() => this.cleanupExpiredMemorySessions(), 10 * 60 * 1000);
  }

  private initRedis() {
    try {
      this.redisClient = new Redis(env.REDIS_URL, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        connectTimeout: 5000,
        retryStrategy: (times) => {
          if (times > 3) return null; // Berhenti retry jika Redis tidak tersedia
          return Math.min(times * 1000, 3000);
        },
      });

      this.redisClient.on('connect', () => {
        this.isRedisReady = true;
        logger.info('⚡ Session Cache: Redis storage connected successfully');
      });

      this.redisClient.on('error', (err) => {
        this.isRedisReady = false;
        logger.warn({ err: err.message }, 'Session Cache: Redis offline/error, falling back to In-Memory store');
      });
    } catch (err: any) {
      this.isRedisReady = false;
      logger.warn({ err: err?.message }, 'Session Cache: Could not init Redis, using In-Memory store');
    }
  }

  /**
   * Membuat sesi login baru dan menyimpannya di cache (Memory + Redis)
   */
  async createSession(
    user: {
      id: string;
      discordId: string;
      username: string;
      role: 'USER' | 'ADMIN';
      avatarUrl?: string;
    },
    rememberMe = true
  ): Promise<{ token: string; session: CachedUserSession; maxAgeSeconds: number }> {
    const token = crypto.randomBytes(32).toString('hex');
    const durationDays = rememberMe ? 30 : 7;
    const maxAgeSeconds = durationDays * 24 * 60 * 60;
    const now = Date.now();
    const expiresAt = now + maxAgeSeconds * 1000;

    const session: CachedUserSession = {
      token,
      userId: user.id,
      discordId: user.discordId,
      username: user.username,
      role: user.role,
      avatarUrl: user.avatarUrl || generateInitialsAvatar(user.username),
      rememberMe,
      createdAt: now,
      expiresAt,
    };

    // 1. Simpan di In-Memory Cache
    this.memoryCache.set(token, session);

    // 2. Simpan di Redis jika aktif
    if (this.isRedisReady && this.redisClient) {
      try {
        await this.redisClient.set(
          `session:${token}`,
          JSON.stringify(session),
          'EX',
          maxAgeSeconds
        );
        // Reverse index untuk lookup per discordId
        await this.redisClient.set(
          `user_session:${user.discordId}`,
          token,
          'EX',
          maxAgeSeconds
        );
      } catch (err) {
        logger.warn({ err }, 'Gagal menyimpan sesi ke Redis, sesi tetap aktif di memori');
      }
    }

    return { token, session, maxAgeSeconds };
  }

  /**
   * Mengambil sesi pengguna berdasarkan token (dengan pengecekan Memory -> Redis)
   */
  async getSession(token: string): Promise<CachedUserSession | null> {
    if (!token) {
      this.misses++;
      return null;
    }

    const now = Date.now();

    // 1. Cek In-Memory Cache (paling cepat, < 1ms)
    const memSession = this.memoryCache.get(token);
    if (memSession) {
      if (memSession.expiresAt > now) {
        this.hits++;
        return memSession;
      } else {
        this.memoryCache.delete(token);
      }
    }

    // 2. Cek Redis jika tidak ditemukan di memori (misal setelah server restart)
    if (this.isRedisReady && this.redisClient) {
      try {
        const raw = await this.redisClient.get(`session:${token}`);
        if (raw) {
          const session = JSON.parse(raw) as CachedUserSession;
          if (session.expiresAt > now) {
            // Restore ke memory cache untuk request berikutnya
            this.memoryCache.set(token, session);
            this.hits++;
            return session;
          } else {
            await this.redisClient.del(`session:${token}`);
          }
        }
      } catch (err) {
        logger.warn({ err }, 'Error membaca sesi dari Redis');
      }
    }

    this.misses++;
    return null;
  }

  /**
   * Menghapus sesi (Logout) dari Memory dan Redis
   */
  async invalidateSession(token: string): Promise<void> {
    if (!token) return;

    const session = this.memoryCache.get(token);
    this.memoryCache.delete(token);

    if (this.isRedisReady && this.redisClient) {
      try {
        await this.redisClient.del(`session:${token}`);
        if (session?.discordId) {
          await this.redisClient.del(`user_session:${session.discordId}`);
        }
      } catch (err) {
        logger.warn({ err }, 'Gagal menghapus sesi dari Redis');
      }
    }
  }

  /**
   * Mengambil statistik performa cache login
   */
  getStats(): CacheStats {
    const totalRequests = this.hits + this.misses;
    const hitRatePercent = totalRequests > 0 ? Math.round((this.hits / totalRequests) * 100) : 100;

    return {
      totalCachedInMemory: this.memoryCache.size,
      redisConnected: this.isRedisReady,
      hits: this.hits,
      misses: this.misses,
      hitRatePercent,
    };
  }

  private cleanupExpiredMemorySessions() {
    const now = Date.now();
    for (const [token, session] of this.memoryCache.entries()) {
      if (session.expiresAt <= now) {
        this.memoryCache.delete(token);
      }
    }
  }
}

export const sessionCache = new SessionCacheService();
