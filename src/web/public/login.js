/**
 * TaskFlow OS • Login & Smart Session Cache Controller
 */

const el = {
  // Brand & Bot
  botStatusBadge: document.getElementById('bot-status-badge'),
  botStatusText: document.getElementById('bot-status-text'),

  // Cache Stats
  cacheActiveCount: document.getElementById('cache-active-count'),
  cacheHitRate: document.getElementById('cache-hit-rate'),
  cacheStorageType: document.getElementById('cache-storage-type'),

  // State Containers
  cachedSessionBox: document.getElementById('cached-session-box'),
  loginFormBox: document.getElementById('login-form-box'),

  // Cached User Profile
  cachedUserAvatar: document.getElementById('cached-user-avatar'),
  cachedUserName: document.getElementById('cached-user-name'),
  cachedUserRole: document.getElementById('cached-user-role'),
  cachedUserMeta: document.getElementById('cached-user-meta'),
  btnContinueDashboard: document.getElementById('btn-continue-dashboard'),
  btnSwitchOrLogout: document.getElementById('btn-switch-or-logout'),

  // Login Controls
  btnOauthDiscord: document.getElementById('btn-oauth-discord'),
  cbRememberMe: document.getElementById('cb-remember-me'),
  registeredUsersList: document.getElementById('registered-users-list'),
  formDirectLogin: document.getElementById('form-direct-login'),
  inputDiscordId: document.getElementById('input-discord-id'),
  btnSubmitDirect: document.getElementById('btn-submit-direct'),

  // Toast
  toastContainer: document.getElementById('toast-container'),
};

function generateInitialsAvatar(name) {
  const clean = (name || 'User').trim();
  const initial = clean.charAt(0).toUpperCase() || 'U';
  const gradients = [
    ['#4F46E5', '#7C3AED'],
    ['#2563EB', '#06B6D4'],
    ['#059669', '#10B981'],
    ['#D97706', '#F59E0B'],
    ['#E11D48', '#FB7185'],
    ['#7C3AED', '#C026D3'],
    ['#0D9488', '#14B8A6'],
    ['#3B82F6', '#8B5CF6'],
  ];
  let hash = 0;
  for (let i = 0; i < clean.length; i++) hash = clean.charCodeAt(i) + ((hash << 5) - hash);
  const [c1, c2] = gradients[Math.abs(hash) % gradients.length];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100"><defs><linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/></linearGradient></defs><circle cx="50" cy="50" r="50" fill="url(#g)"/><text x="50" y="55" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" font-size="44" font-weight="700" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${initial}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

// ==========================================
// 1. Inisialisasi
// ==========================================
document.addEventListener('DOMContentLoaded', async () => {
  handleUrlParams();
  setupEventListeners();

  // 1. Cek cache login lokal terlebih dahulu (Instan, 0ms)
  await checkLocalSessionCache();

  // 2. Load metrics bot & server cache
  loadLiveMetrics();

  // 3. Load akun terdaftar untuk quick login
  loadRegisteredUsers();
});

// ==========================================
// 2. Client-Side Session Cache Handling
// ==========================================
async function checkLocalSessionCache() {
  const cachedJson = localStorage.getItem('taskflow_cached_session');
  const cachedToken = localStorage.getItem('taskflow_session_token');

  if (cachedJson) {
    try {
      const session = JSON.parse(cachedJson);
      // Validasi waktu kedaluwarsa lokal
      if (session.expiresAt && Date.now() > session.expiresAt) {
        clearLocalSession();
        return;
      }

      // Tampilkan UI Sesi Aktif di Cache
      renderCachedSessionUI(session);

      // Verifikasi di latar belakang ke server
      verifySessionWithServer(cachedToken || session.token);
    } catch (e) {
      clearLocalSession();
    }
  } else {
    // Coba restore via token di cookie jika ada
    try {
      const res = await fetch('/auth/restore-session', { method: 'POST' });
      if (res.ok) {
        const data = await res.json();
        if (data.user) {
          saveSessionToLocal(data.user);
          renderCachedSessionUI(data.user);
        }
      }
    } catch (err) {
      // Abaikan jika tidak ada sesi aktif
    }
  }
}

async function verifySessionWithServer(token) {
  try {
    const res = await fetch('/auth/restore-session', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (res.ok) {
      const data = await res.json();
      if (data.user) {
        saveSessionToLocal(data.user);
        renderCachedSessionUI(data.user);
      }
    } else {
      // Sesi server sudah expired/dihapus
      clearLocalSession();
      showLoginFormUI();
    }
  } catch (err) {
    // Jika offline, pertahankan sesi lokal
    console.warn('Gagal memverifikasi sesi server:', err);
  }
}

function renderCachedSessionUI(user) {
  el.loginFormBox.style.display = 'none';
  el.cachedSessionBox.style.display = 'flex';

  el.cachedUserName.textContent = user.username || 'Mahasiswa TaskFlow';
  const fallbackAvatar = generateInitialsAvatar(user.username || 'user');
  el.cachedUserAvatar.src = user.avatarUrl || fallbackAvatar;
  el.cachedUserAvatar.onerror = function() {
    this.onerror = null;
    this.src = fallbackAvatar;
  };

  if (user.role === 'ADMIN') {
    el.cachedUserRole.textContent = '👑 ADMIN';
    el.cachedUserRole.style.color = '#FBBF24';
  } else {
    el.cachedUserRole.textContent = 'USER';
    el.cachedUserRole.style.color = '#94A3B8';
  }

  el.cachedUserMeta.textContent = `Discord ID: ${user.discordId || '-'}`;
}

function showLoginFormUI() {
  el.cachedSessionBox.style.display = 'none';
  el.loginFormBox.style.display = 'flex';
}

function saveSessionToLocal(user) {
  localStorage.setItem('taskflow_cached_session', JSON.stringify(user));
  if (user.token) {
    localStorage.setItem('taskflow_session_token', user.token);
  }
}

function clearLocalSession() {
  localStorage.removeItem('taskflow_cached_session');
  localStorage.removeItem('taskflow_session_token');
}

// ==========================================
// 3. Live Metrics & Registered Users
// ==========================================
async function loadLiveMetrics() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();

    // Bot Status
    if (data.bot?.online) {
      el.botStatusText.textContent = `Bot Online • ${data.bot.pingMs || 25}ms`;
    } else {
      el.botStatusText.textContent = 'Bot Offline';
    }

    // Cache Stats
    if (data.sessionCache) {
      el.cacheActiveCount.textContent = data.sessionCache.totalCachedInMemory || 0;
      el.cacheHitRate.textContent = `${data.sessionCache.hitRatePercent || 100}%`;
      el.cacheStorageType.textContent = data.sessionCache.redisConnected ? 'Redis (Shared)' : 'RAM (In-Memory)';
    }
  } catch (err) {
    el.botStatusText.textContent = 'Bot Terhubung';
  }
}

async function loadRegisteredUsers() {
  try {
    const res = await fetch('/auth/registered-users');
    if (!res.ok) throw new Error('Gagal memuat');
    const data = await res.json();

    if (!data.users || data.users.length === 0) {
      el.registeredUsersList.innerHTML = `
        <div style="font-size: 0.78rem; color: var(--text-dim); grid-column: span 2;">
          Belum ada akun di database. Masuk via Discord OAuth untuk mendaftar otomatis.
        </div>
      `;
      return;
    }

    el.registeredUsersList.innerHTML = data.users
      .map(
        (u) => `
        <button type="button" class="user-chip" data-discord-id="${u.discordId}" title="Klik untuk masuk sebagai ${escapeHtml(u.username)}">
          <img class="user-chip-avatar" src="${u.avatarUrl || generateInitialsAvatar(u.username)}" alt="${escapeHtml(u.username)}" onerror="this.onerror=null; this.src=generateInitialsAvatar('${escapeHtml(u.username)}');">
          <div class="user-chip-info">
            <span class="user-chip-name">${escapeHtml(u.username)}</span>
            <span class="user-chip-role ${u.role === 'ADMIN' ? 'admin' : 'user'}">
              ${u.role === 'ADMIN' ? '👑 ADMIN' : 'USER'} • XP ${u.xp}
            </span>
          </div>
        </button>
      `
      )
      .join('');

    // Tambahkan event click pada setiap user chip
    el.registeredUsersList.querySelectorAll('.user-chip').forEach((chip) => {
      chip.addEventListener('click', async () => {
        const discordId = chip.dataset.discordId;
        el.inputDiscordId.value = discordId;
        await performDirectLogin(discordId);
      });
    });
  } catch (err) {
    el.registeredUsersList.innerHTML = `
      <div style="font-size: 0.78rem; color: var(--text-dim); grid-column: span 2;">
        Gunakan tombol Discord OAuth atau masukkan Discord ID Anda di bawah.
      </div>
    `;
  }
}

// ==========================================
// 4. Action Handlers (Login, Direct, Logout)
// ==========================================
function setupEventListeners() {
  // Update Discord OAuth link dengan status Remember Me
  el.cbRememberMe.addEventListener('change', () => {
    updateDiscordAuthLink();
  });
  updateDiscordAuthLink();

  // Form Direct Login
  el.formDirectLogin.addEventListener('submit', async (e) => {
    e.preventDefault();
    const discordId = el.inputDiscordId.value.trim();
    if (!discordId) {
      showToast('Harap masukkan Discord ID Anda', 'error');
      return;
    }
    await performDirectLogin(discordId);
  });

  // Switch or Logout Button
  el.btnSwitchOrLogout.addEventListener('click', async () => {
    try {
      await fetch('/auth/logout', { method: 'POST' });
    } catch {}
    clearLocalSession();
    showLoginFormUI();
    showToast('Sesi telah dibersihkan dari cache. Silakan pilih akun baru.', 'info');
  });

  // Tombol Lanjutkan ke Dashboard
  const btnContinue = document.getElementById('btn-continue-dashboard');
  if (btnContinue) {
    btnContinue.addEventListener('click', async (e) => {
      e.preventDefault();
      const cachedToken = localStorage.getItem('taskflow_session_token');
      if (cachedToken) {
        try {
          await fetch('/auth/restore-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ token: cachedToken }),
          });
        } catch (err) {}
      }
      window.location.href = '/';
    });
  }
}

function updateDiscordAuthLink() {
  const remember = el.cbRememberMe.checked;
  el.btnOauthDiscord.href = `/auth/discord?remember=${remember}`;
}

async function performDirectLogin(discordId) {
  const rememberMe = el.cbRememberMe.checked;
  el.btnSubmitDirect.disabled = true;
  el.btnSubmitDirect.innerHTML = '<span>Memuat...</span>';

  try {
    const res = await fetch('/auth/direct-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ discordId, rememberMe }),
    });

    const data = await res.json();

    if (!res.ok) {
      showToast(data.error || 'Gagal login dengan Discord ID tersebut', 'error');
      return;
    }

    // Simpan ke local cache
    saveSessionToLocal(data.user);

    showToast('✨ ' + (data.message || 'Login berhasil! Sesi Anda telah dicache.'), 'success');

    // Auto-redirect ke Dashboard
    setTimeout(() => {
      window.location.href = '/';
    }, 600);
  } catch (err) {
    console.error('Direct login error:', err);
    showToast('Terjadi kesalahan koneksi ke server', 'error');
  } finally {
    el.btnSubmitDirect.disabled = false;
    el.btnSubmitDirect.innerHTML = '<span>Masuk</span>';
  }
}

// ==========================================
// 5. Toast & URL Query Parser
// ==========================================
function handleUrlParams() {
  const params = new URLSearchParams(window.location.search);

  if (params.get('logout') === '1') {
    clearLocalSession();
    showToast('🚪 Anda telah berhasil logout dan cache sesi dibersihkan.', 'info');
  } else if (params.get('expired') === '1') {
    clearLocalSession();
    showToast('⚠️ Sesi login Anda telah berakhir atau belum aktif. Silakan masuk kembali.', 'warning');
  } else if (params.get('required') === '1') {
    showToast('🔒 Silakan login terlebih dahulu untuk mengakses Dashboard TaskFlow.', 'warning');
  } else if (params.get('error') === 'oauth_unconfigured') {
    showToast('⚠️ Discord OAuth2 belum diisi di .env. Gunakan Masuk Cepat di bawah.', 'error');
  } else if (params.get('error') === 'token_exchange_failed') {
    showToast('❌ Gagal memvalidasi token Discord OAuth2.', 'error');
  } else if (params.get('error')) {
    showToast(`⚠️ Otentikasi gagal: ${params.get('error')}`, 'error');
  }
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
    <div>${escapeHtml(message)}</div>
  `;

  el.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(20px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, (tag) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;',
  }[tag] || tag));
}
