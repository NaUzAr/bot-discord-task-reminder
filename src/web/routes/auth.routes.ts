import { Router, Request, Response } from 'express';
import { env } from '../../config/env';
import { prisma } from '../../database/prisma';
import { logger } from '../../shared/utils/logger';
import { sessionCache } from '../services/session-cache.service';
import { generateInitialsAvatar } from '../../shared/utils/avatar';

export const authRouter = Router();

// 1. Inisiasi login Discord OAuth2
authRouter.get(['/login', '/discord'], (req: Request, res: Response) => {
  if (!env.CLIENT_ID || !env.DISCORD_CLIENT_SECRET) {
    return res.redirect('/login?error=oauth_unconfigured');
  }

  const rememberMe = req.query.remember !== 'false';
  const statePayload = Buffer.from(JSON.stringify({ rememberMe, ts: Date.now() })).toString('base64url');
  const redirectUri = `${env.WEB_BASE_URL}/auth/callback`;
  const discordAuthUrl = `https://discord.com/oauth2/authorize?client_id=${env.CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&scope=identify+guilds&state=${statePayload}`;

  return res.redirect(discordAuthUrl);
});

// 2. Callback dari Discord OAuth2
authRouter.get('/callback', async (req: Request, res: Response) => {
  const code = req.query.code as string;
  const state = req.query.state as string;

  if (!code) {
    return res.redirect('/login?error=missing_code');
  }

  let rememberMe = true;
  if (state) {
    try {
      const parsedState = JSON.parse(Buffer.from(state, 'base64url').toString('utf-8'));
      if (typeof parsedState.rememberMe === 'boolean') {
        rememberMe = parsedState.rememberMe;
      }
    } catch {
      // Abaikan jika parsing state gagal
    }
  }

  try {
    const redirectUri = `${env.WEB_BASE_URL}/auth/callback`;

    // Exchange authorization code dengan access token
    const tokenResponse = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: env.CLIENT_ID || '',
        client_secret: env.DISCORD_CLIENT_SECRET || '',
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      logger.error({ errText }, 'Gagal exchange token Discord OAuth2');
      return res.redirect('/login?error=token_exchange_failed');
    }

    const tokenData = (await tokenResponse.json()) as { access_token: string };

    // Fetch user profile dari Discord
    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
      },
    });

    if (!userRes.ok) {
      return res.redirect('/login?error=fetch_user_failed');
    }

    const discordUser = (await userRes.json()) as {
      id: string;
      username: string;
      global_name?: string;
      avatar?: string;
    };

    // Cek apakah Discord ID termasuk admin
    const adminIds = env.ADMIN_DISCORD_IDS
      ? env.ADMIN_DISCORD_IDS.split(',').map((id: string) => id.trim()).filter(Boolean)
      : ['388612656678043649'];
    const isAutoAdmin = adminIds.includes(discordUser.id);

    // Upsert user di PostgreSQL Prisma
    const dbUser = await prisma.user.upsert({
      where: { discordId: discordUser.id },
      update: {
        username: discordUser.global_name || discordUser.username,
        lastActiveAt: new Date(),
        ...(isAutoAdmin ? { role: 'ADMIN' } : {}),
      },
      create: {
        discordId: discordUser.id,
        username: discordUser.global_name || discordUser.username,
        lastActiveAt: new Date(),
        role: isAutoAdmin ? 'ADMIN' : 'USER',
      },
    });

    const avatarUrl = discordUser.avatar
      ? `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.png`
      : `https://cdn.discordapp.com/embed/avatars/${parseInt(discordUser.id.slice(-2)) % 5}.png`;

    // Simpan ke Session Cache (Redis + Memory)
    const { token, session, maxAgeSeconds } = await sessionCache.createSession(
      {
        id: dbUser.id,
        discordId: dbUser.discordId,
        username: dbUser.username,
        role: dbUser.role,
        avatarUrl,
      },
      rememberMe
    );

    const maxAgeMs = maxAgeSeconds * 1000;

    // Set Token Cookie & Session Cookie
    res.cookie('taskflow_session_token', token, {
      httpOnly: false,
      maxAge: maxAgeMs,
      sameSite: 'lax',
    });

    res.cookie('taskflow_session', JSON.stringify(session), {
      httpOnly: false,
      maxAge: maxAgeMs,
      sameSite: 'lax',
    });

    return res.redirect('/?login=success');
  } catch (error) {
    logger.error({ error }, 'Error saat proses Discord OAuth callback');
    return res.redirect('/login?error=internal_auth_error');
  }
});

// 3. Direct Login / Fast Login (Menggunakan Discord ID pengguna terdaftar)
authRouter.post('/direct-login', async (req: Request, res: Response) => {
  const { discordId, rememberMe = true } = req.body;

  if (!discordId || typeof discordId !== 'string') {
    return res.status(400).json({ error: 'Discord ID wajib diisi' });
  }

  const cleanDiscordId = discordId.trim();

  // Cari user di database
  let dbUser = await prisma.user.findUnique({
    where: { discordId: cleanDiscordId },
  });

  // Jika belum ada tapi termasuk admin ID, auto-create akun admin
  const adminIds = env.ADMIN_DISCORD_IDS
    ? env.ADMIN_DISCORD_IDS.split(',').map((id: string) => id.trim()).filter(Boolean)
    : ['388612656678043649'];

  if (!dbUser && adminIds.includes(cleanDiscordId)) {
    dbUser = await prisma.user.create({
      data: {
        discordId: cleanDiscordId,
        username: 'Admin TaskFlow',
        role: 'ADMIN',
        lastActiveAt: new Date(),
      },
    });
  }

  if (!dbUser) {
    return res.status(404).json({
      error: 'Akun Discord ID ini belum terdaftar. Silakan login via Discord OAuth2 terlebih dahulu.',
    });
  }

  // Update last active
  await prisma.user.update({
    where: { id: dbUser.id },
    data: { lastActiveAt: new Date() },
  });

  // Simpan ke Session Cache
  const { token, session, maxAgeSeconds } = await sessionCache.createSession(
    {
      id: dbUser.id,
      discordId: dbUser.discordId,
      username: dbUser.username,
      role: dbUser.role,
    },
    Boolean(rememberMe)
  );

  const maxAgeMs = maxAgeSeconds * 1000;

  res.cookie('taskflow_session_token', token, {
    httpOnly: false,
    maxAge: maxAgeMs,
    sameSite: 'lax',
  });

  res.cookie('taskflow_session', JSON.stringify(session), {
    httpOnly: false,
    maxAge: maxAgeMs,
    sameSite: 'lax',
  });

  return res.json({
    success: true,
    message: 'Login berhasil! Sesi dicache dalam memori & Redis.',
    user: session,
    token,
  });
});

// 4. Restore Session dari Local Cache Token
authRouter.post('/restore-session', async (req: Request, res: Response) => {
  const token =
    req.body?.token ||
    req.cookies?.taskflow_session_token ||
    (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null);

  if (!token) {
    return res.status(401).json({ authenticated: false, error: 'Token sesi tidak ditemukan' });
  }

  const cachedSession = await sessionCache.getSession(token);
  if (!cachedSession) {
    return res.status(401).json({ authenticated: false, error: 'Sesi di cache telah kedaluwarsa' });
  }

  // Re-issue cookie jika perlu
  const remainingMs = Math.max(1000 * 60, cachedSession.expiresAt - Date.now());
  res.cookie('taskflow_session_token', token, {
    httpOnly: false,
    maxAge: remainingMs,
    sameSite: 'lax',
  });

  res.cookie('taskflow_session', JSON.stringify(cachedSession), {
    httpOnly: false,
    maxAge: remainingMs,
    sameSite: 'lax',
  });

  return res.json({
    authenticated: true,
    cached: true,
    user: cachedSession,
  });
});

// 5. Daftar Pengguna Terdaftar untuk Quick-Select di Login UI
authRouter.get('/registered-users', async (_req: Request, res: Response) => {
  try {
    const users = await prisma.user.findMany({
      orderBy: { xp: 'desc' },
      take: 6,
      select: {
        id: true,
        discordId: true,
        username: true,
        role: true,
        xp: true,
        streak: true,
      },
    });

    return res.json({
      hasOauthConfigured: !!(env.CLIENT_ID && env.DISCORD_CLIENT_SECRET),
      users: users.map((u) => ({
        ...u,
        avatarUrl: generateInitialsAvatar(u.username),
      })),
    });
  } catch (err) {
    return res.status(500).json({ error: 'Gagal mengambil data user terdaftar' });
  }
});

// 6. Cache Stats Monitor
authRouter.get('/cache-stats', (_req: Request, res: Response) => {
  return res.json(sessionCache.getStats());
});

// 7. Logout (Clear Cache & Cookies)
const handleLogout = async (req: Request, res: Response) => {
  const token = req.cookies?.taskflow_session_token || req.body?.token;
  if (token) {
    await sessionCache.invalidateSession(token);
  }

  res.clearCookie('taskflow_session');
  res.clearCookie('taskflow_session_token');

  if (req.headers.accept?.includes('application/json') || req.method === 'POST') {
    return res.json({ success: true, message: 'Berhasil logout dan cache sesi dihapus' });
  }

  return res.redirect('/login?logout=1');
};

authRouter.get('/logout', handleLogout);
authRouter.post('/logout', handleLogout);
