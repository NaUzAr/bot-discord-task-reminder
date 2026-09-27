import { Response } from 'express';
import { logger } from '../../shared/utils/logger';

export interface SSEMessage {
  type: 'task:changed' | 'status:changed' | 'announcement' | 'ping';
  payload?: any;
  timestamp: number;
}

class SSEService {
  private clients: Set<Response> = new Set();
  private heartbeatInterval: NodeJS.Timeout | null = null;

  constructor() {
    // Keep-alive heartbeat setiap 25 detik agar koneksi tidak diputus reverse proxy / browser
    this.heartbeatInterval = setInterval(() => {
      this.broadcast('ping', { heartbeat: true });
    }, 25000);
  }

  /**
   * Mendaftarkan client SSE baru
   */
  addClient(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Khusus Nginx jika ada reverse proxy
    res.flushHeaders?.();

    this.clients.add(res);
    logger.debug(`[SSE] Client connected. Total active clients: ${this.clients.size}`);

    // Kirim event welcome
    const welcomeMsg: SSEMessage = {
      type: 'status:changed',
      payload: { connected: true, clientsCount: this.clients.size },
      timestamp: Date.now(),
    };
    res.write(`data: ${JSON.stringify(welcomeMsg)}\n\n`);

    // Bersihkan saat koneksi ditutup
    res.on('close', () => {
      this.clients.delete(res);
      logger.debug(`[SSE] Client disconnected. Total active clients: ${this.clients.size}`);
    });
  }

  /**
   * Mengirim event ke semua client yang sedang terhubung
   */
  broadcast(type: SSEMessage['type'], payload?: any): void {
    if (this.clients.size === 0) return;

    const message: SSEMessage = {
      type,
      payload,
      timestamp: Date.now(),
    };

    const data = `data: ${JSON.stringify(message)}\n\n`;

    for (const client of this.clients) {
      try {
        client.write(data);
      } catch (err) {
        this.clients.delete(client);
      }
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

export const sseService = new SSEService();
