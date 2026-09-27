import express from 'express';
import cookieParser from 'cookie-parser';
import path from 'path';
import fs from 'fs';
import { Client } from 'discord.js';
import { env } from '../config/env';
import { logger } from '../shared/utils/logger';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { authRouter } from './routes/auth.routes';
import { createApiRouter } from './routes/api.routes';
import { sessionCache } from './services/session-cache.service';

export function startWebServer(client?: Client) {
  const app = express();

  // 1. Security Headers with Helmet
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com'],
          imgSrc: ["'self'", 'data:', 'https://cdn.discordapp.com', 'https://api.dicebear.com'],
          connectSrc: ["'self'"],
        },
      },
      crossOriginEmbedderPolicy: false,
    })
  );

  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));
  app.use(cookieParser());

  // Log incoming requests in debug
  app.use((req, _res, next) => {
    logger.debug({ method: req.method, url: req.url }, 'Incoming Web Request');
    next();
  });

  // 2. Rate Limiters untuk Keamanan Endpoint
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 40,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Terlalu banyak percobaan autentikasi. Silakan coba kembali dalam 15 menit.' },
  });

  const aiLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Batas kuota ekstraksi AI tercapai. Harap tunggu beberapa menit sebelum mencoba lagi.' },
  });

  const generalLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
  });

  // API Routes terproteksi
  app.use('/auth', authLimiter, authRouter);
  app.use('/api/ai', aiLimiter);
  app.use('/api', generalLimiter, createApiRouter(client));

  // Static files handling (Mendukung baik saat run via tsx maupun build dist)
  const candidatePaths = [
    path.join(__dirname, 'public'),
    path.join(process.cwd(), 'src', 'web', 'public'),
    path.join(process.cwd(), 'dist', 'web', 'public'),
  ];
  const publicDir = candidatePaths.find(p => fs.existsSync(p)) || path.join(__dirname, 'public');

  // Halaman Login Route (Bebas diakses)
  app.get('/login', (_req, res) => {
    const loginPath = path.join(publicDir, 'login.html');
    if (fs.existsSync(loginPath)) {
      res.sendFile(loginPath);
    } else {
      res.redirect('/');
    }
  });

  // Proteksi Route Dashboard Utama (Wajib Login: Belum login -> redirect ke /login)
  app.get(['/', '/index.html'], async (req, res, next) => {
    const token =
      req.cookies?.taskflow_session_token ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

    if (!token) {
      return res.redirect('/login');
    }

    const session = await sessionCache.getSession(token);
    if (!session) {
      res.clearCookie('taskflow_session_token');
      res.clearCookie('taskflow_session');
      return res.redirect('/login?expired=1');
    }

    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      return res.sendFile(indexPath);
    }
    next();
  });

  // Static files (dengan index: false agar tidak membypass proteksi auth di atas)
  app.use(express.static(publicDir, { index: false }));

  // SPA fallback (kompatibel dengan Express 4 & Express 5)
  app.use(async (req, res) => {
    // Abaikan permintaan aset static yang hilang (seperti favicon atau icon)
    if (req.path.includes('.')) {
      return res.status(404).end();
    }

    const token =
      req.cookies?.taskflow_session_token ||
      (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

    if (!token) {
      return res.redirect('/login');
    }

    const session = await sessionCache.getSession(token);
    if (!session) {
      res.clearCookie('taskflow_session_token');
      res.clearCookie('taskflow_session');
      return res.redirect('/login?expired=1');
    }

    const indexPath = path.join(publicDir, 'index.html');
    if (fs.existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.send(`<h1>TaskFlow OS Web Server Active</h1><p>Public UI directory not found at ${publicDir}</p>`);
    }
  });

  const port = env.PORT || 3000;
  const server = app.listen(port, () => {
    logger.info(`🌐 Web Dashboard online & listening at: ${env.WEB_BASE_URL || `http://localhost:${port}`}`);
  });

  return server;
}
