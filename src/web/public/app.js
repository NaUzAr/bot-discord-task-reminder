// TaskFlow OS - Frontend Application Logic

// Toast Notification System
function showToast(message, type = 'info') {
  const icons = { success: '✅', info: 'ℹ️', warning: '⚠️', error: '❌' };
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type] || '💬'}</span><span>${message}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4200);
}

const state = {
  activeTab: 'radar',
  currentUser: null,
  tasks: [],
  knownCourses: new Set(),
  radarData: null,
  timer: {
    duration: 25 * 60,
    remaining: 25 * 60,
    isRunning: false,
    intervalId: null,
    totalMinutes: 25,
  },
};

// DOM References
const el = {
  navItems: document.querySelectorAll('.nav-item'),
  tabPanes: document.querySelectorAll('.tab-pane'),
  pageTitle: document.getElementById('page-title'),
  pageSubtitle: document.getElementById('page-subtitle'),

  // Mobile elements
  btnMobileMenu: document.getElementById('btn-mobile-menu'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  sidebar: document.querySelector('.sidebar'),

  // User Profile
  userName: document.getElementById('user-name'),
  userLevel: document.getElementById('user-level'),
  userRoleBadge: document.getElementById('user-role-badge'),
  userStreak: document.getElementById('user-streak'),
  userAvatar: document.getElementById('user-avatar'),
  userXpFill: document.getElementById('user-xp-fill'),
  userWidget: document.getElementById('user-widget'),
  accountDropdown: document.getElementById('account-dropdown'),
  btnDiscordLogin: document.getElementById('btn-discord-login'),
  btnLogout: document.getElementById('btn-logout'),

  // Bot Status Sidebar
  botStatusText: document.getElementById('bot-status-text'),
  botMetaInfo: document.getElementById('bot-meta-info'),

  // Radar
  radarTodayCount: document.getElementById('radar-today-count'),
  radarTomorrowCount: document.getElementById('radar-tomorrow-count'),
  radarWeekCount: document.getElementById('radar-week-count'),
  radarOverdueCount: document.getElementById('radar-overdue-count'),
  radarGroupsContainer: document.getElementById('radar-groups-container'),
  badgeRadarUrgent: document.getElementById('badge-radar-urgent'),

  // Kanban
  kanbanColTodo: document.getElementById('kanban-col-todo'),
  kanbanColInProgress: document.getElementById('kanban-col-in-progress'),
  kanbanColDone: document.getElementById('kanban-col-done'),
  countTodo: document.getElementById('count-todo'),
  countInProgress: document.getElementById('count-in-progress'),
  countDone: document.getElementById('count-done'),
  badgeKanbanTotal: document.getElementById('badge-kanban-total'),
  kanbanSearch: document.getElementById('kanban-search'),
  filterCourse: document.getElementById('filter-course'),
  filterPriority: document.getElementById('filter-priority'),
  btnRefreshKanban: document.getElementById('btn-refresh-kanban'),

  // Leaderboard
  podiumSection: document.getElementById('podium-section'),
  leaderboardTableBody: document.getElementById('leaderboard-table-body'),

  // Focus Timer
  timerCountdown: document.getElementById('timer-countdown'),
  timerStateLabel: document.getElementById('timer-state-label'),
  timerProgressCircle: document.getElementById('timer-progress-circle'),
  btnTimerToggle: document.getElementById('btn-timer-toggle'),
  btnTimerReset: document.getElementById('btn-timer-reset'),
  timerModeBtns: document.querySelectorAll('.timer-btn-mode'),
  focusTaskDropdown: document.getElementById('focus-task-dropdown'),
  focusSessionsCount: document.getElementById('focus-sessions-count'),

  // Health
  healthBotStatus: document.getElementById('health-bot-status'),
  healthBotTag: document.getElementById('health-bot-tag'),
  healthBotPing: document.getElementById('health-bot-ping'),
  healthBotGuilds: document.getElementById('health-bot-guilds'),
  healthBotUptime: document.getElementById('health-bot-uptime'),
  healthDbTasks: document.getElementById('health-db-tasks'),
  healthDbDone: document.getElementById('health-db-done'),
  healthDbUsers: document.getElementById('health-db-users'),
  healthQueueDelayed: document.getElementById('health-queue-delayed'),
  healthQueueActive: document.getElementById('health-queue-active'),
  healthCacheSessions: document.getElementById('health-cache-sessions'),
  healthCacheHitrate: document.getElementById('health-cache-hitrate'),
  healthCacheEngine: document.getElementById('health-cache-engine'),

  // Modals
  btnOpenCreateModal: document.getElementById('btn-open-create-modal'),
  modalCreateTask: document.getElementById('modal-create-task'),
  btnCloseCreateModal: document.getElementById('btn-close-create-modal'),
  btnCancelCreate: document.getElementById('btn-cancel-create'),
  formCreateTask: document.getElementById('form-create-task'),

  // Settings Modal
  btnOpenSettings: document.getElementById('btn-open-settings'),
  modalSettings: document.getElementById('modal-settings'),
  btnCloseSettingsModal: document.getElementById('btn-close-settings-modal'),
  btnCancelSettings: document.getElementById('btn-cancel-settings'),
  formSettings: document.getElementById('form-settings'),
  settingTimezone: document.getElementById('setting-timezone'),
  settingQuietEnabled: document.getElementById('setting-quiet-enabled'),
  settingQuietStart: document.getElementById('setting-quiet-start'),
  settingQuietEnd: document.getElementById('setting-quiet-end'),
  settingDmEnabled: document.getElementById('setting-dm-enabled'),
};

// ==========================================
// 1. Inisialisasi & Setup Auth
// ==========================================
async function initApp() {
  // Gatekeeper: Jika pengguna belum login sama sekali, langsung alihkan ke /login
  const cachedJson = localStorage.getItem('taskflow_cached_session');
  const cachedToken = localStorage.getItem('taskflow_session_token');
  const hasCookie = document.cookie.includes('taskflow_session_token');

  if (!cachedJson && !cachedToken && !hasCookie) {
    window.location.replace('/login');
    return;
  }

  setupNavigation();
  setupTimer();
  setupModals();
  setupAccountMenu();
  setupKanbanDragAndDrop();
  setupSSE();
  setupExportModal();
  setupAIMagicParser();
  setupAdminPanel();
  setupPWA();
  setupNotifications();

  await loadCurrentUser();
  await refreshAllData();

  // Auto-refresh fallback setiap 60 detik (sudah didukung real-time SSE)
  setInterval(refreshAllData, 60000);
}

async function loadCurrentUser() {
  // 1. Instant Cache-First Load dari localStorage (0ms rendering)
  const cachedJson = localStorage.getItem('taskflow_cached_session');
  if (cachedJson) {
    try {
      const cachedUser = JSON.parse(cachedJson);
      state.currentUser = cachedUser;
      renderUserProfile();
      if (el.btnDiscordLogin) el.btnDiscordLogin.style.display = 'none';
      if (el.btnLogout) el.btnLogout.style.display = 'flex';
    } catch (e) {
      // Abaikan jika parse gagal
    }
  }

  // 2. Verifikasi & Sinkronisasi dengan server
  try {
    let res = await fetch('/api/me');

    // Jika 401 dan ada token di localStorage, coba restore session
    if (!res.ok) {
      const cachedToken = localStorage.getItem('taskflow_session_token');
      if (cachedToken) {
        const restoreRes = await fetch('/auth/restore-session', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: cachedToken }),
        });
        if (restoreRes.ok) {
          res = await fetch('/api/me');
        }
      }
    }

    if (res.ok) {
      const data = await res.json();
      state.currentUser = data.user;
      localStorage.setItem('taskflow_cached_session', JSON.stringify(data.user));
      renderUserProfile();
      if (el.btnDiscordLogin) el.btnDiscordLogin.style.display = 'none';
      if (el.btnLogout) el.btnLogout.style.display = 'flex';
    } else {
      // Sesi tidak valid / kedaluwarsa di server: bersihkan dan alihkan ke login
      state.currentUser = null;
      localStorage.removeItem('taskflow_cached_session');
      localStorage.removeItem('taskflow_session_token');
      window.location.replace('/login?expired=1');
      return;
    }
  } catch (err) {
    console.error('Error load user profile:', err);
  }
}

function renderUserProfile() {
  if (!state.currentUser) return;
  const u = state.currentUser;
  el.userName.textContent = u.username;
  el.userLevel.textContent = `LVL ${u.level || 1}`;
  el.userStreak.textContent = `🔥 ${u.streak || 0}`;
  el.userXpFill.style.width = `${u.progressPercent || 0}%`;
  el.userXpFill.parentElement.title = `XP: ${u.xp} (${u.progressPercent || 0}% menuju level berikutnya)`;

  if (el.userRoleBadge) {
    if (u.role === 'ADMIN') {
      el.userRoleBadge.style.display = 'inline-block';
      el.userRoleBadge.textContent = '👑 ADMIN';
    } else {
      el.userRoleBadge.style.display = 'none';
    }
  }

  // Tampilkan tab Admin jika role adalah ADMIN
  const navAdmin = document.getElementById('nav-item-admin');
  const mobileNavAdmin = document.getElementById('mobile-nav-admin');
  if (navAdmin) navAdmin.style.display = u.role === 'ADMIN' ? 'flex' : 'none';
  if (mobileNavAdmin) mobileNavAdmin.style.display = u.role === 'ADMIN' ? 'flex' : 'none';

  if (u.avatarUrl) {
    el.userAvatar.src = u.avatarUrl;
  }
}

// ==========================================
// 2. Navigasi & Tab Handling
// ==========================================
const TAB_TITLES = {
  radar: { title: '🚨 Deadline Radar', subtitle: 'Pantau dan kelola batas waktu tugas kuliah secara real-time' },
  kanban: { title: '📋 Kanban Board', subtitle: 'Visualisasi alur pengerjaan tugas akademik (To Do, In Progress, Selesai)' },
  leaderboard: { title: '🏆 Student Leaderboard', subtitle: 'Peringkat mahasiswa terajin berdasarkan XP, streak, dan tugas selesai' },
  focus: { title: '⏱️ Focus Room (Pomodoro)', subtitle: 'Sesi belajar mendalam bebas gangguan (+1 XP per menit fokus)' },
  status: { title: '⚡ System & Bot Health', subtitle: 'Metrik live bot Discord, antrean BullMQ, dan PostgreSQL' },
  architecture: { title: '🏛️ Arsitektur & Spesifikasi Sistem', subtitle: 'Diagram arsitektur sistem, teknologi, dan alur kerja TaskFlow OS' },
  admin: { title: '👑 Panel Admin & Dosen', subtitle: 'Manajemen direktori mahasiswa, hak akses, siaran pengumuman, dan kontrol cache' },
};

function setupNavigation() {
  el.navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.dataset.tab;
      switchTab(targetTab);
      closeMobileSidebar();
    });
  });

  document.querySelectorAll('.mobile-nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const targetTab = item.dataset.tab;
      switchTab(targetTab);
      closeMobileSidebar();
    });
  });

  if (el.btnMobileMenu) {
    el.btnMobileMenu.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleMobileSidebar();
    });
  }

  if (el.sidebarBackdrop) {
    el.sidebarBackdrop.addEventListener('click', () => {
      closeMobileSidebar();
    });
  }
}

function toggleMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar?.classList.toggle('show-mobile');
  backdrop?.classList.toggle('show');
}

function closeMobileSidebar() {
  const sidebar = document.querySelector('.sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebar?.classList.remove('show-mobile');
  backdrop?.classList.remove('show');
}

function switchTab(tabId) {
  state.activeTab = tabId;

  el.navItems.forEach(i => i.classList.toggle('active', i.dataset.tab === tabId));
  document.querySelectorAll('.mobile-nav-item').forEach(i => i.classList.toggle('active', i.dataset.tab === tabId));
  el.tabPanes.forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));

  const meta = TAB_TITLES[tabId] || { title: 'TaskFlow OS', subtitle: '' };
  el.pageTitle.textContent = meta.title;
  el.pageSubtitle.textContent = meta.subtitle;

  if (tabId === 'radar') loadRadar();
  if (tabId === 'kanban') loadKanban();
  if (tabId === 'leaderboard') loadLeaderboard();
  if (tabId === 'status') loadHealth();
  if (tabId === 'admin') loadAdminData();
}

// ==========================================
// 3. Fetching & Rendering Data
// ==========================================
async function refreshAllData() {
  await Promise.all([
    loadHealth(),
    loadRadar(),
    loadKanban(),
  ]);
}

// 🚨 DEADLINE RADAR
async function loadRadar() {
  try {
    const res = await fetch('/api/radar');
    if (!res.ok) return;
    const data = await res.json();
    state.radarData = data;

    // Update Counts
    el.radarTodayCount.textContent = data.summary.todayCount;
    el.radarTomorrowCount.textContent = data.summary.tomorrowCount;
    el.radarWeekCount.textContent = data.summary.thisWeekCount;
    el.radarOverdueCount.textContent = data.summary.overdueCount;

    const urgentTotal = data.summary.todayCount + data.summary.overdueCount;
    el.badgeRadarUrgent.textContent = urgentTotal;
    el.badgeRadarUrgent.style.display = urgentTotal > 0 ? 'inline-block' : 'none';

    renderRadarSections(data);
  } catch (err) {
    console.error('Error load radar:', err);
  }
}

function renderRadarSections(data) {
  const sections = [
    { key: 'overdue', label: '🔴 Sudah Terlewat (Overdue)', items: data.overdue, badgeClass: 'URGENT' },
    { key: 'today', label: '⚠️ Deadline Hari Ini', items: data.today, badgeClass: 'URGENT' },
    { key: 'tomorrow', label: '⏰ Deadline Besok', items: data.tomorrow, badgeClass: 'HIGH' },
    { key: 'thisWeek', label: '📅 Deadline Minggu Ini', items: data.thisWeek, badgeClass: 'MEDIUM' },
    { key: 'later', label: '📌 Mendatang Lainnya', items: data.later, badgeClass: 'LOW' },
  ];

  let html = '';
  let totalTasks = 0;

  sections.forEach(sec => {
    if (sec.items && sec.items.length > 0) {
      totalTasks += sec.items.length;
      html += `
        <div class="radar-section">
          <div class="radar-section-header">
            <div class="radar-title">
              <span>${sec.label}</span>
              <span class="count-pill">${sec.items.length} Tugas</span>
            </div>
          </div>
          <div class="radar-items-grid">
            ${sec.items.map(t => renderTaskCard(t)).join('')}
          </div>
        </div>
      `;
    }
  });

  if (totalTasks === 0) {
    html = `
      <div class="radar-section text-center" style="padding: 3rem; text-align: center;">
        <span style="font-size: 3rem;">🎉</span>
        <h3 style="margin-top: 1rem; color: var(--text-main);">Tidak ada deadline mendesak!</h3>
        <p style="color: var(--text-muted); margin-top: 0.5rem;">Seluruh tugas Anda telah tuntas atau belum memiliki batas waktu.</p>
      </div>
    `;
  }

  el.radarGroupsContainer.innerHTML = html;
  attachTaskCardEvents();
}

// 📋 KANBAN BOARD & DRAG-AND-DROP SYSTEM
function getGoogleCalendarUrl(task) {
  if (!task.dueAt) return null;
  try {
    const due = new Date(task.dueAt);
    if (isNaN(due.getTime())) return null;
    const start = new Date(due.getTime() - 60 * 60 * 1000);
    const formatGDate = (d) => d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const title = encodeURIComponent(`[TaskFlow] ${task.title}`);
    const details = encodeURIComponent(
      `${task.description || ''}\n\nPrioritas: ${task.priority}\nStatus: ${task.status}\nTipe: ${task.taskType}\nTaskFlow Dashboard`
    );
    return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${title}&dates=${formatGDate(start)}/${formatGDate(due)}&details=${details}`;
  } catch {
    return null;
  }
}

function updateCourseFilterOptions(tasks) {
  if (!el.filterCourse) return;
  // Collect courses
  tasks.forEach(t => {
    if (t.courseId && t.courseId.trim()) {
      state.knownCourses.add(t.courseId.trim());
    }
  });

  const currentVal = el.filterCourse.value || 'ALL';
  let html = '<option value="ALL">📚 Semua Mata Kuliah</option>';
  Array.from(state.knownCourses).sort().forEach(c => {
    html += `<option value="${escapeHtml(c)}" ${c === currentVal ? 'selected' : ''}>📚 ${escapeHtml(c)}</option>`;
  });
  el.filterCourse.innerHTML = html;
}

async function loadKanban() {
  try {
    const search = el.kanbanSearch.value.trim();
    const priority = el.filterPriority.value;
    const course = el.filterCourse ? el.filterCourse.value : 'ALL';
    const url = `/api/tasks?search=${encodeURIComponent(search)}&priority=${priority}&course=${encodeURIComponent(course)}`;

    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    state.tasks = data.tasks;

    updateCourseFilterOptions(data.tasks);

    // Smart Sorting
    const sortVal = document.getElementById('sort-kanban')?.value || 'due-asc';
    data.tasks.sort((a, b) => {
      if (sortVal === 'due-asc') {
        const timeA = a.dueAt ? new Date(a.dueAt).getTime() : Infinity;
        const timeB = b.dueAt ? new Date(b.dueAt).getTime() : Infinity;
        return timeA - timeB;
      } else if (sortVal === 'due-desc') {
        const timeA = a.dueAt ? new Date(a.dueAt).getTime() : -Infinity;
        const timeB = b.dueAt ? new Date(b.dueAt).getTime() : -Infinity;
        return timeB - timeA;
      } else if (sortVal === 'priority-desc') {
        const pOrder = { URGENT: 4, HIGH: 3, MEDIUM: 2, LOW: 1 };
        return (pOrder[b.priority] || 0) - (pOrder[a.priority] || 0);
      } else if (sortVal === 'created-desc') {
        return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
      }
      return 0;
    });

    const todoTasks = data.tasks.filter(t => t.status === 'TODO');
    const inProgressTasks = data.tasks.filter(t => t.status === 'IN_PROGRESS');
    const doneTasks = data.tasks.filter(t => t.status === 'DONE');

    el.countTodo.textContent = todoTasks.length;
    el.countInProgress.textContent = inProgressTasks.length;
    el.countDone.textContent = doneTasks.length;
    el.badgeKanbanTotal.textContent = data.tasks.length;

    el.kanbanColTodo.innerHTML = todoTasks.map(t => renderTaskCard(t, 'TODO')).join('');
    el.kanbanColInProgress.innerHTML = inProgressTasks.map(t => renderTaskCard(t, 'IN_PROGRESS')).join('');
    el.kanbanColDone.innerHTML = doneTasks.map(t => renderTaskCard(t, 'DONE')).join('');

    // Update Dropdown di Focus Room
    updateFocusTaskDropdown(data.tasks.filter(t => t.status !== 'DONE'));

    attachTaskCardEvents();
  } catch (err) {
    console.error('Error load kanban:', err);
  }
}

function renderTaskCard(task, colContext) {
  const isDone = task.status === 'DONE';
  const deadlineStr = task.dueAt ? formatRelativeDeadline(new Date(task.dueAt)) : 'Tanpa batas waktu';
  const taskTypeLabel = task.taskType === 'GROUP' ? '👥 Kelompok' : '👤 Individu';

  // Course Badge
  let courseBadge = '';
  if (task.courseId) {
    courseBadge = `<span class="task-course-badge" title="Mata Kuliah">📚 ${escapeHtml(task.courseId)}</span>`;
  }

  // Interactive Subtasks checklist & progress
  let subtasksHtml = '';
  if (task.subtasks && task.subtasks.length > 0) {
    const doneCount = task.subtasks.filter(s => s.status === 'DONE').length;
    const total = task.subtasks.length;
    const pct = Math.round((doneCount / total) * 100);
    subtasksHtml = `
      <div class="task-subtasks-summary">
        <div style="display: flex; justify-content: space-between; font-size: 0.72rem; color: var(--text-dim); margin-bottom: 0.35rem;">
          <span>🧩 Sub-tugas (${doneCount}/${total})</span>
          <span>${pct}%</span>
        </div>
        <div class="subtask-progress-bar">
          <div class="subtask-progress-fill" style="width: ${pct}%;"></div>
        </div>
        <div class="subtasks-list">
          ${task.subtasks.map(s => `
            <label class="subtask-checkbox-item ${s.status === 'DONE' ? 'completed' : ''}" title="Klik untuk menandai selesai/buka (+10 XP)">
              <input type="checkbox" class="subtask-checkbox" data-subtask-id="${s.id}" data-task-id="${task.id}" ${s.status === 'DONE' ? 'checked' : ''}>
              <span>${escapeHtml(s.title)}</span>
            </label>
          `).join('')}
        </div>
      </div>
    `;
  }

  // External Action Badges (LMS & Google Calendar)
  const gcalUrl = getGoogleCalendarUrl(task);
  let extBadges = '';
  if (task.linkUrl || gcalUrl) {
    extBadges = '<div class="task-ext-badges">';
    if (task.linkUrl) {
      extBadges += `<a href="${escapeHtml(task.linkUrl)}" target="_blank" rel="noopener noreferrer" class="task-ext-btn link" title="Buka tautan pengumpulan LMS">🔗 LMS / Link</a>`;
    }
    if (gcalUrl) {
      extBadges += `<a href="${gcalUrl}" target="_blank" rel="noopener noreferrer" class="task-ext-btn calendar" title="Sinkronkan tenggat waktu ke Google Calendar">📅 Google Cal</a>`;
    }
    extBadges += '</div>';
  }

  // Action buttons
  let actionBtns = '';
  if (task.status === 'TODO') {
    actionBtns += `<button class="btn btn-secondary btn-sm btn-move-task" data-id="${task.id}" data-to="IN_PROGRESS" title="Mulai kerjakan tugas">▶️ Kerjakan</button>`;
    actionBtns += `<button class="btn btn-success btn-sm btn-move-task" data-id="${task.id}" data-to="DONE" title="Tandai selesai">✅ Selesai</button>`;
  } else if (task.status === 'IN_PROGRESS') {
    actionBtns += `<button class="btn btn-secondary btn-sm btn-move-task" data-id="${task.id}" data-to="TODO" title="Tunda tugas kembali">⏸️ Tunda</button>`;
    actionBtns += `<button class="btn btn-success btn-sm btn-move-task" data-id="${task.id}" data-to="DONE" title="Tandai selesai dan dapatkan +50 XP">✅ Selesai (+50 XP)</button>`;
  } else if (task.status === 'DONE') {
    actionBtns += `<button class="btn btn-secondary btn-sm btn-move-task" data-id="${task.id}" data-to="TODO" title="Buka kembali tugas">↩️ Buka Kembali</button>`;
  }

  // Quick Snooze button for active tasks
  let snoozeBtn = '';
  if (task.status !== 'DONE') {
    snoozeBtn = `<button class="btn btn-secondary btn-sm btn-snooze-task" data-id="${task.id}" title="Tunda pengingat bot selama 1 jam">⏰ Tunda 1 Jam</button>`;
  }

  const snoozeBadge = task.snoozeCount > 0
    ? `<span style="font-size: 0.7rem; color: #FBBF24; margin-left: 0.3rem;" title="Pengingat telah ditunda ${task.snoozeCount} kali">(${task.snoozeCount}x ditunda)</span>`
    : '';

  return `
    <div class="task-card ${isDone ? 'is-done' : ''}" data-id="${task.id}" draggable="true">
      <div class="task-card-header">
        <div style="display: flex; flex-direction: column; gap: 0.25rem;">
          <h4 class="task-title" style="${isDone ? 'text-decoration: line-through; opacity: 0.6;' : ''}">${escapeHtml(task.title)}</h4>
          ${courseBadge}
        </div>
        <span class="task-priority-badge ${task.priority}">${task.priority}</span>
      </div>

      ${task.description ? `<p style="font-size: 0.8rem; color: var(--text-muted); line-height: 1.4; margin-top: 0.35rem;">${escapeHtml(task.description)}</p>` : ''}

      <div class="task-meta">
        <div class="task-meta-item">
          <span>⏰</span>
          <span>${deadlineStr}</span>
          ${snoozeBadge}
        </div>
        <div class="task-meta-item">
          <span>${taskTypeLabel}</span>
        </div>
      </div>

      ${extBadges}
      ${subtasksHtml}

      <div class="task-card-actions">
        ${actionBtns}
        ${snoozeBtn}
        <button class="btn btn-secondary btn-sm btn-delete-task" data-id="${task.id}" title="Hapus Tugas" style="color: #F87171;">🗑️</button>
      </div>
    </div>
  `;
}

function setupKanbanDragAndDrop() {
  const cols = document.querySelectorAll('.kanban-col');
  cols.forEach(col => {
    col.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      col.classList.add('drag-hover');
    });

    col.addEventListener('dragleave', (e) => {
      if (!col.contains(e.relatedTarget)) {
        col.classList.remove('drag-hover');
      }
    });

    col.addEventListener('drop', async (e) => {
      e.preventDefault();
      col.classList.remove('drag-hover');
      const taskId = e.dataTransfer.getData('text/plain');
      const targetStatus = col.dataset.status;
      if (!taskId || !targetStatus) return;

      try {
        const res = await fetch(`/api/tasks/${taskId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: targetStatus }),
        });

        if (res.ok) {
          const statusNames = {
            TODO: 'Belum Dikerjakan',
            IN_PROGRESS: 'Sedang Berjalan',
            DONE: 'Selesai (+50 XP)',
          };
          showToast(`📋 Tugas dipindahkan ke: ${statusNames[targetStatus] || targetStatus}`, targetStatus === 'DONE' ? 'success' : 'info');
          await refreshAllData();
          await loadCurrentUser();
        } else {
          showToast('Gagal memindahkan tugas', 'error');
        }
      } catch (err) {
        console.error('Error drop task:', err);
        showToast('Gagal memindahkan tugas', 'error');
      }
    });
  });
}

function attachTaskCardEvents() {
  // Drag start & end on cards
  document.querySelectorAll('.task-card').forEach(card => {
    card.setAttribute('draggable', 'true');
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', card.dataset.id);
      e.dataTransfer.effectAllowed = 'move';
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
    });
  });

  // Manual move button
  document.querySelectorAll('.btn-move-task').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.dataset.id;
      const targetStatus = btn.dataset.to;

      try {
        const res = await fetch(`/api/tasks/${taskId}/status`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: targetStatus }),
        });
        if (res.ok) {
          const labels = {
            DONE: '✅ Tugas diselesaikan! +50 XP',
            IN_PROGRESS: '▶️ Tugas mulai dikerjakan',
            TODO: '⏸️ Tugas ditunda kembali'
          };
          showToast(labels[targetStatus] || 'Status diperbarui', targetStatus === 'DONE' ? 'success' : 'info');
          await refreshAllData();
          await loadCurrentUser();
        } else {
          showToast('Gagal memperbarui status tugas', 'error');
        }
      } catch (err) {
        console.error('Error move task:', err);
        showToast('Koneksi ke server gagal', 'error');
      }
    });
  });

  // Subtask checkbox toggle
  document.querySelectorAll('.subtask-checkbox').forEach(chk => {
    chk.addEventListener('change', async (e) => {
      e.stopPropagation();
      const subtaskId = chk.dataset.subtaskId;
      try {
        const res = await fetch(`/api/subtasks/${subtaskId}/toggle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        if (res.ok) {
          const data = await res.json();
          const isNowDone = data.subtask?.status === 'DONE';
          showToast(isNowDone ? '✅ Sub-tugas diselesaikan! +10 XP' : '↩️ Sub-tugas dibuka kembali', isNowDone ? 'success' : 'info');
          await refreshAllData();
          await loadCurrentUser();
        } else {
          showToast('Gagal mengubah sub-tugas', 'error');
          chk.checked = !chk.checked;
        }
      } catch (err) {
        console.error('Error toggle subtask:', err);
        showToast('Koneksi gagal', 'error');
        chk.checked = !chk.checked;
      }
    });
  });

  // Snooze task button
  document.querySelectorAll('.btn-snooze-task').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const taskId = btn.dataset.id;
      try {
        const res = await fetch(`/api/tasks/${taskId}/snooze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ minutes: 60 }),
        });
        if (res.ok) {
          const data = await res.json();
          showToast(`⏰ Pengingat ditunda 60 menit (Total: ${data.snoozeCount}x ditunda)`, 'info');
          await refreshAllData();
        } else {
          showToast('Gagal menunda pengingat tugas', 'error');
        }
      } catch (err) {
        console.error('Error snooze task:', err);
        showToast('Gagal menunda pengingat', 'error');
      }
    });
  });

  // Delete task button
  document.querySelectorAll('.btn-delete-task').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm('Apakah Anda yakin ingin menghapus tugas ini?')) return;
      const taskId = btn.dataset.id;

      try {
        const res = await fetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
        if (res.ok) {
          showToast('🗑️ Tugas berhasil dihapus', 'warning');
          await refreshAllData();
        }
      } catch (err) {
        console.error('Error delete task:', err);
        showToast('Gagal menghapus tugas', 'error');
      }
    });
  });
}

// 🏆 LEADERBOARD
async function loadLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) return;
    const { leaderboard } = await res.json();

    // Render Podium (Top 3)
    const top3 = leaderboard.slice(0, 3);
    const podiumBadges = ['🥇 Juara 1', '🥈 Juara 2', '🥉 Juara 3'];
    el.podiumSection.innerHTML = top3.map((u, i) => `
      <div class="podium-card rank-${u.rank}">
        <span class="podium-badge">${podiumBadges[i] || '🎖️'}</span>
        <img class="podium-avatar" src="${u.avatarUrl}" alt="Avatar">
        <h4 class="podium-name">${escapeHtml(u.username)}</h4>
        <span class="podium-xp">⚡ ${u.xp} XP</span>
        <span style="font-size: 0.75rem; color: var(--text-dim); margin-top: 0.25rem;">🔥 ${u.streak} Hari Streak</span>
      </div>
    `).join('');

    // Render Table
    el.leaderboardTableBody.innerHTML = leaderboard.map(u => `
      <tr>
        <td><strong>#${u.rank}</strong></td>
        <td>
          <div style="display: flex; align-items: center; gap: 0.6rem;">
            <img src="${u.avatarUrl}" width="28" height="28" style="border-radius: 50%;">
            <span>${escapeHtml(u.username)}</span>
          </div>
        </td>
        <td><span class="user-level">LVL ${u.level}</span></td>
        <td>🔥 ${u.streak} Hari</td>
        <td>✅ ${u.completedTasks} Tugas</td>
        <td><strong style="color: var(--accent-cyan);">${u.xp} XP</strong></td>
      </tr>
    `).join('');
  } catch (err) {
    console.error('Error load leaderboard:', err);
  }
}

// ⚡ SYSTEM & BOT HEALTH
async function loadHealth() {
  try {
    const res = await fetch('/api/status');
    if (!res.ok) return;
    const data = await res.json();

    // Topbar & Sidebar status
    el.botStatusText.textContent = data.bot.online ? `Bot: Online` : `Bot: Offline`;
    el.botMetaInfo.textContent = `Ping: ${data.bot.pingMs} ms • ${data.bot.guildsCount} Server`;

    // Health Tab
    el.healthBotStatus.textContent = data.bot.online ? 'ONLINE' : 'OFFLINE';
    el.healthBotTag.textContent = data.bot.user;
    el.healthBotPing.textContent = `${data.bot.pingMs} ms`;
    el.healthBotGuilds.textContent = `${data.bot.guildsCount} Server Discord`;
    el.healthBotUptime.textContent = `${Math.floor(data.bot.uptimeSeconds / 60)} menit`;

    el.healthDbTasks.textContent = `${data.database.totalTasks} Tugas`;
    el.healthDbDone.textContent = `${data.database.completedTasks} Tugas`;
    el.healthDbUsers.textContent = `${data.database.totalUsers} Mahasiswa`;

    el.healthQueueDelayed.textContent = `${data.queue.delayed} Reminders`;
    el.healthQueueActive.textContent = `${data.queue.active} Jobs`;

    if (data.sessionCache) {
      if (el.healthCacheSessions) el.healthCacheSessions.textContent = `${data.sessionCache.totalCachedInMemory || 0} Sesi`;
      if (el.healthCacheHitrate) el.healthCacheHitrate.textContent = `${data.sessionCache.hitRatePercent || 100}%`;
      if (el.healthCacheEngine) el.healthCacheEngine.textContent = data.sessionCache.redisConnected ? 'Redis (Shared)' : 'RAM (In-Memory)';
    }
  } catch (err) {
    console.error('Error load health:', err);
  }
}

// ==========================================
// 4. Focus Pomodoro Timer & Audio Feedback
// ==========================================
function playPomodoroChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const now = ctx.currentTime;
    // Pleasant dual chime (F#5 -> A#5 -> C#6)
    const notes = [739.99, 932.33, 1108.73];
    notes.forEach((freq, idx) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(freq, now + idx * 0.16);
      gain.gain.setValueAtTime(0, now + idx * 0.16);
      gain.gain.linearRampToValueAtTime(0.22, now + idx * 0.16 + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + idx * 0.16 + 0.9);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(now + idx * 0.16);
      osc.stop(now + idx * 0.16 + 0.95);
    });
  } catch (err) {
    console.warn('Audio chime could not be played:', err);
  }
}

function setupTimer() {
  const circle = el.timerProgressCircle;
  const radius = circle.r.baseVal.value;
  const circumference = 2 * Math.PI * radius;

  circle.style.strokeDasharray = `${circumference} ${circumference}`;
  circle.style.strokeDashoffset = '0';

  function setProgress(percent) {
    const offset = circumference - (percent / 100) * circumference;
    circle.style.strokeDashoffset = offset;
  }

  function updateDisplay() {
    const mins = Math.floor(state.timer.remaining / 60);
    const secs = state.timer.remaining % 60;
    el.timerCountdown.textContent = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;

    const percent = ((state.timer.duration - state.timer.remaining) / state.timer.duration) * 100;
    setProgress(percent);
  }

  el.timerModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      if (state.timer.isRunning) clearInterval(state.timer.intervalId);
      state.timer.isRunning = false;
      el.btnTimerToggle.textContent = 'Mulai Fokus';
      el.btnTimerToggle.classList.remove('btn-secondary');
      el.btnTimerToggle.classList.add('btn-primary');
      el.timerStateLabel.textContent = 'Siap Memulai';

      el.timerModeBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const mins = parseInt(btn.dataset.time, 10);
      state.timer.totalMinutes = mins;
      state.timer.duration = mins * 60;
      state.timer.remaining = mins * 60;
      updateDisplay();
    });
  });

  el.btnTimerToggle.addEventListener('click', () => {
    if (state.timer.isRunning) {
      // Pause
      clearInterval(state.timer.intervalId);
      state.timer.isRunning = false;
      el.btnTimerToggle.textContent = 'Lanjutkan';
      el.timerStateLabel.textContent = 'Dijeda (Paused)';
    } else {
      // Start
      state.timer.isRunning = true;
      el.btnTimerToggle.textContent = 'Jeda';
      el.timerStateLabel.textContent = '🔥 Sedang Fokus...';

      state.timer.intervalId = setInterval(async () => {
        if (state.timer.remaining > 0) {
          state.timer.remaining--;
          updateDisplay();
        } else {
          // Timer Selesai!
          clearInterval(state.timer.intervalId);
          state.timer.isRunning = false;
          el.btnTimerToggle.textContent = 'Mulai Lagi';
          el.timerStateLabel.textContent = '🎉 Sesi Fokus Selesai!';

          // Bunyikan chime audio penanda selesai
          playPomodoroChime();

          // Log session to DB
          try {
            const taskId = el.focusTaskDropdown.value || null;
            await fetch('/api/focus/log', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                durationMinutes: state.timer.totalMinutes,
                taskId,
              }),
            });
            showToast(`🎉 Sesi fokus ${state.timer.totalMinutes} menit selesai! +${state.timer.totalMinutes} XP`, 'success');
            await loadCurrentUser();
          } catch (err) {
            console.error('Error logging focus session:', err);
            showToast('Gagal menyimpan sesi fokus', 'error');
          }
        }
      }, 1000);
    }
  });

  el.btnTimerReset.addEventListener('click', () => {
    if (state.timer.isRunning) clearInterval(state.timer.intervalId);
    state.timer.isRunning = false;
    state.timer.remaining = state.timer.duration;
    el.btnTimerToggle.textContent = 'Mulai Fokus';
    el.timerStateLabel.textContent = 'Siap Memulai';
    updateDisplay();
  });

  updateDisplay();
}

function updateFocusTaskDropdown(tasks) {
  const currentVal = el.focusTaskDropdown.value;
  el.focusTaskDropdown.innerHTML = `
    <option value="">(Umum / Belajar Mandiri)</option>
    ${tasks.map(t => `<option value="${t.id}" ${t.id === currentVal ? 'selected' : ''}>${escapeHtml(t.title)}</option>`).join('')}
  `;
}

// ==========================================
// 5. Modals & Task Creation
// ==========================================
function setupModals() {
  // Create Task Modal
  el.btnOpenCreateModal.addEventListener('click', () => {
    el.modalCreateTask.classList.add('show');
  });

  const closeCreate = () => el.modalCreateTask.classList.remove('show');
  el.btnCloseCreateModal.addEventListener('click', closeCreate);
  el.btnCancelCreate.addEventListener('click', closeCreate);

  el.formCreateTask.addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('task-title').value.trim();
    const priority = document.getElementById('task-priority').value;
    const taskType = document.getElementById('task-type').value;
    const courseName = document.getElementById('task-course')?.value.trim() || null;
    const dueAt = document.getElementById('task-due').value || null;
    const description = document.getElementById('task-desc').value.trim() || null;
    const linkUrl = document.getElementById('task-link').value.trim() || null;
    const subtasksText = document.getElementById('task-subtasks-input')?.value.trim() || '';
    const subtasks = subtasksText ? subtasksText.split('\n').map(s => s.trim()).filter(Boolean) : [];

    try {
      const res = await fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, priority, taskType, courseName, dueAt, description, linkUrl, subtasks }),
      });

      if (res.ok) {
        closeCreate();
        el.formCreateTask.reset();
        showToast('📝 Tugas baru berhasil dibuat!', 'success');
        await refreshAllData();
      } else {
        showToast('Gagal membuat tugas. Periksa isian form.', 'error');
      }
    } catch (err) {
      console.error('Error submit task:', err);
      showToast('Koneksi ke server gagal', 'error');
    }
  });

  // Settings Modal
  if (el.btnOpenSettings) {
    el.btnOpenSettings.addEventListener('click', () => {
      el.accountDropdown.classList.remove('show');
      if (state.currentUser) {
        if (el.settingTimezone) el.settingTimezone.value = state.currentUser.timezone || 'Asia/Jakarta';
        if (el.settingQuietEnabled) el.settingQuietEnabled.checked = state.currentUser.quietHoursEnabled ?? true;
        if (el.settingQuietStart) el.settingQuietStart.value = state.currentUser.quietHoursStart || '23:00';
        if (el.settingQuietEnd) el.settingQuietEnd.value = state.currentUser.quietHoursEnd || '07:00';
        if (el.settingDmEnabled) el.settingDmEnabled.checked = state.currentUser.dmReminders ?? true;
      }
      el.modalSettings.classList.add('show');
    });
  }

  const closeSettings = () => el.modalSettings?.classList.remove('show');
  el.btnCloseSettingsModal?.addEventListener('click', closeSettings);
  el.btnCancelSettings?.addEventListener('click', closeSettings);

  el.formSettings?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const timezone = el.settingTimezone.value;
    const quietHoursEnabled = el.settingQuietEnabled.checked;
    const quietHoursStart = el.settingQuietStart.value;
    const quietHoursEnd = el.settingQuietEnd.value;
    const dmReminders = el.settingDmEnabled.checked;

    try {
      const res = await fetch('/api/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timezone,
          quietHoursEnabled,
          quietHoursStart,
          quietHoursEnd,
          dmReminders,
        }),
      });

      if (res.ok) {
        closeSettings();
        showToast('⚙️ Pengaturan & Jam Tenang berhasil disimpan!', 'success');
        await loadCurrentUser();
      } else {
        showToast('Gagal menyimpan pengaturan', 'error');
      }
    } catch (err) {
      console.error('Error save settings:', err);
      showToast('Koneksi ke server gagal', 'error');
    }
  });

  // Filter & Sort Kanban
  el.kanbanSearch.addEventListener('input', debounce(loadKanban, 300));
  el.filterPriority.addEventListener('change', loadKanban);
  if (el.filterCourse) {
    el.filterCourse.addEventListener('change', loadKanban);
  }
  document.getElementById('sort-kanban')?.addEventListener('change', loadKanban);
  el.btnRefreshKanban.addEventListener('click', loadKanban);
}

function setupAccountMenu() {
  el.userWidget.addEventListener('click', (e) => {
    e.stopPropagation();
    el.accountDropdown.classList.toggle('show');
  });

  document.addEventListener('click', () => {
    el.accountDropdown.classList.remove('show');
  });

  if (el.btnLogout) {
    el.btnLogout.addEventListener('click', () => {
      localStorage.removeItem('taskflow_cached_session');
      localStorage.removeItem('taskflow_session_token');
    });
  }
}

// Helpers
function formatRelativeDeadline(targetDate) {
  const now = new Date();
  const diffMs = targetDate.getTime() - now.getTime();
  const diffHours = Math.round(diffMs / (1000 * 60 * 60));
  const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

  if (diffMs < 0) {
    const overdueHours = Math.abs(diffHours);
    if (overdueHours < 24) return `🔴 Terlewat ${overdueHours} jam`;
    return `🔴 Terlewat ${Math.abs(diffDays)} hari`;
  }

  if (diffHours < 1) return `🔥 Kurang dari 1 jam lagi!`;
  if (diffHours < 24) return `⏰ ${diffHours} jam lagi`;
  if (diffDays === 1) return `Besok (${targetDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })})`;
  return `${targetDate.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })} (${targetDate.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })})`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>'"]/g, tag => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#39;',
    '"': '&quot;'
  }[tag] || tag));
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// ==========================================
// 5. Real-Time SSE (Server-Sent Events)
// ==========================================
function setupSSE() {
  const syncIndicator = document.getElementById('sse-sync-indicator');
  if (!window.EventSource) return;

  const evtSource = new EventSource('/api/events');

  evtSource.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'task:changed') {
        refreshAllData();
      } else if (msg.type === 'announcement') {
        showToast(`📢 [Pengumuman]: ${msg.payload?.title || ''}`, 'info');
        sendBrowserNotification(`📢 Pengumuman: ${msg.payload?.title || 'Pengumuman Baru'}`, {
          body: msg.payload?.message || 'Ada pengumuman baru dari Admin di kelas.',
        });
        refreshAllData();
      } else if (msg.type === 'status:changed') {
        loadHealth();
        if (state.currentUser?.role === 'ADMIN') loadAdminData();
      }
    } catch (e) {}
  };

  evtSource.onopen = () => {
    if (syncIndicator) {
      syncIndicator.classList.remove('disconnected');
      syncIndicator.title = 'Sinkronisasi Real-Time Aktif (Live SSE Connected)';
    }
  };

  evtSource.onerror = () => {
    if (syncIndicator) {
      syncIndicator.classList.add('disconnected');
      syncIndicator.title = 'Koneksi Live Terputus (Menggunakan Polling)';
    }
  };
}

// ==========================================
// 6. Export Modal Handlers
// ==========================================
function setupExportModal() {
  const btnOpen = document.getElementById('btn-open-export-modal');
  const modal = document.getElementById('modal-export-schedule');
  const btnClose = document.getElementById('btn-close-export-modal');
  const btnCloseFooter = document.getElementById('btn-close-export-btn');
  const btnCopyWA = document.getElementById('btn-copy-wa-rekap');
  const waPreviewWrap = document.getElementById('wa-preview-wrap');
  const waRekapText = document.getElementById('wa-rekap-text');

  if (btnOpen && modal) {
    btnOpen.addEventListener('click', () => modal.classList.add('show'));
  }
  if (btnClose && modal) {
    btnClose.addEventListener('click', () => modal.classList.remove('show'));
  }
  if (btnCloseFooter && modal) {
    btnCloseFooter.addEventListener('click', () => modal.classList.remove('show'));
  }

  if (btnCopyWA) {
    btnCopyWA.addEventListener('click', async () => {
      btnCopyWA.disabled = true;
      btnCopyWA.textContent = 'Membuat Rekap...';
      try {
        const res = await fetch('/api/export/whatsapp');
        if (res.ok) {
          const data = await res.json();
          if (waRekapText) waRekapText.value = data.text;
          if (waPreviewWrap) waPreviewWrap.style.display = 'block';

          // Copy ke clipboard
          await navigator.clipboard.writeText(data.text);
          showToast('📋 Rekap WhatsApp berhasil disalin ke clipboard!', 'success');
        } else {
          showToast('Gagal membuat format rekap WhatsApp', 'error');
        }
      } catch (err) {
        showToast('Gagal menyalin ke clipboard', 'error');
      } finally {
        btnCopyWA.disabled = false;
        btnCopyWA.textContent = 'Salin Teks WA';
      }
    });
  }
}

// ==========================================
// 7. AI Magic Input Modal Handlers
// ==========================================
function setupAIMagicParser() {
  const tabManual = document.getElementById('modal-tab-manual');
  const tabAI = document.getElementById('modal-tab-ai');
  const aiParseBox = document.getElementById('ai-parse-box');
  const btnRunAI = document.getElementById('btn-run-ai-parse');
  const aiPromptInput = document.getElementById('ai-prompt-input');

  if (tabManual && tabAI && aiParseBox) {
    tabManual.addEventListener('click', () => {
      tabManual.classList.add('active');
      tabAI.classList.remove('active');
      aiParseBox.style.display = 'none';
    });

    tabAI.addEventListener('click', () => {
      tabAI.classList.add('active');
      tabManual.classList.remove('active');
      aiParseBox.style.display = 'flex';
      if (aiPromptInput) aiPromptInput.focus();
    });
  }

  if (btnRunAI && aiPromptInput) {
    btnRunAI.addEventListener('click', async () => {
      const prompt = aiPromptInput.value.trim();
      if (prompt.length < 3) {
        showToast('Masukkan instruksi tugas terlebih dahulu', 'error');
        return;
      }

      btnRunAI.disabled = true;
      btnRunAI.innerHTML = '<span>⏳ Memproses dengan Gemini AI...</span>';

      try {
        const res = await fetch('/api/ai/parse-task', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt }),
        });

        const data = await res.json();
        if (res.ok && data.parsed) {
          const p = data.parsed;

          // Auto-fill form fields
          const titleInput = document.getElementById('task-title');
          const prioritySelect = document.getElementById('task-priority');
          const typeSelect = document.getElementById('task-type');
          const courseInput = document.getElementById('task-course');
          const dueInput = document.getElementById('task-due');
          const descInput = document.getElementById('task-desc');
          const subtasksInput = document.getElementById('task-subtasks-input');

          if (titleInput && p.title) titleInput.value = p.title;
          if (prioritySelect && p.priority) prioritySelect.value = p.priority;
          if (typeSelect && p.taskType) typeSelect.value = p.taskType;
          if (courseInput && p.courseName) courseInput.value = p.courseName;
          if (descInput && p.description) descInput.value = p.description;

          if (dueInput && p.dueAt) {
            try {
              const d = new Date(p.dueAt);
              const tzOffset = d.getTimezoneOffset() * 60000;
              const localISOTime = new Date(d.getTime() - tzOffset).toISOString().slice(0, 16);
              dueInput.value = localISOTime;
            } catch (e) {}
          }

          if (subtasksInput && Array.isArray(p.subtasks)) {
            subtasksInput.value = p.subtasks.join('\n');
          }

          // Kembali ke tab manual untuk review & simpan
          if (tabManual) tabManual.click();
          showToast('✨ Tugas berhasil diekstrak oleh AI! Silakan periksa formulir.', 'success');
        } else {
          showToast(data.error || 'Gagal mengekstrak tugas dengan AI', 'error');
        }
      } catch (err) {
        showToast('Koneksi ke AI gagal', 'error');
      } finally {
        btnRunAI.disabled = false;
        btnRunAI.innerHTML = '<span>✨ Ekstrak Otomatis dengan AI</span>';
      }
    });
  }
}

// ==========================================
// 8. Admin Panel Management Logic
// ==========================================
function setupAdminPanel() {
  const btnRefresh = document.getElementById('btn-refresh-admin-users');
  const formBroadcast = document.getElementById('form-admin-broadcast');
  const btnFlushCache = document.getElementById('btn-flush-cache');

  if (btnRefresh) {
    btnRefresh.addEventListener('click', loadAdminData);
  }

  if (formBroadcast) {
    formBroadcast.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = document.getElementById('broadcast-title')?.value.trim();
      const message = document.getElementById('broadcast-message')?.value.trim();
      const urgent = document.getElementById('broadcast-urgent')?.checked;

      if (!title || !message) return;

      const submitBtn = document.getElementById('btn-submit-broadcast');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Menyiarkan...';
      }

      try {
        const res = await fetch('/api/admin/broadcast', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, message, urgent }),
        });

        const data = await res.json();
        if (res.ok) {
          showToast(`📢 ${data.message || 'Pengumuman terkirim!'}`, 'success');
          formBroadcast.reset();
        } else {
          showToast(data.error || 'Gagal mengirim pengumuman', 'error');
        }
      } catch (err) {
        showToast('Gagal terhubung ke server', 'error');
      } finally {
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.innerHTML = '<span>Kirim ke Discord 🚀</span>';
        }
      }
    });
  }

  if (btnFlushCache) {
    btnFlushCache.addEventListener('click', async () => {
      if (!confirm('Apakah Anda yakin ingin me-reset / membersihkan seluruh cache sesi?')) return;
      try {
        const res = await fetch('/api/admin/cache/flush', { method: 'POST' });
        const data = await res.json();
        if (res.ok) {
          showToast('🧹 ' + (data.message || 'Cache berhasil dibersihkan'), 'success');
          loadAdminData();
        } else {
          showToast(data.error || 'Gagal membersihkan cache', 'error');
        }
      } catch (err) {
        showToast('Error koneksi server', 'error');
      }
    });
  }

  const btnRefreshAudit = document.getElementById('btn-refresh-audit-logs');
  if (btnRefreshAudit) {
    btnRefreshAudit.addEventListener('click', loadAdminAuditLogs);
  }
}

async function loadAdminData() {
  const tbody = document.getElementById('admin-users-tbody');
  const cacheSessionsEl = document.getElementById('admin-cache-sessions');
  const cacheHitrateEl = document.getElementById('admin-cache-hitrate');

  try {
    const [usersRes, statusRes] = await Promise.all([
      fetch('/api/admin/users'),
      fetch('/api/status'),
    ]);

    if (usersRes.ok && tbody) {
      const { users } = await usersRes.json();
      if (!users || users.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7">Tidak ada pengguna terdaftar</td></tr>';
      } else {
        tbody.innerHTML = users.map((u) => {
          const isTargetAdmin = u.role === 'ADMIN';
          const toggleRoleAction = isTargetAdmin ? 'USER' : 'ADMIN';
          const btnLabel = isTargetAdmin ? 'Jadikan User' : '👑 Angkat Admin';
          const btnClass = isTargetAdmin ? 'btn-outline' : 'btn-primary';

          return `
            <tr>
              <td>
                <div style="display: flex; align-items: center; gap: 0.6rem;">
                  <img src="https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(u.username)}" width="28" height="28" style="border-radius: 50%;">
                  <strong>${escapeHtml(u.username)}</strong>
                </div>
              </td>
              <td><code>${u.discordId}</code></td>
              <td><span class="user-level">LVL ${Math.floor(u.xp / 100) + 1}</span> • ${u.xp} XP</td>
              <td>🔥 ${u.streak} Hari</td>
              <td>✅ ${u._count?.tasks || 0} Tugas</td>
              <td>
                <span class="${isTargetAdmin ? 'user-role-badge' : 'user-level'}">
                  ${isTargetAdmin ? '👑 ADMIN' : 'USER'}
                </span>
              </td>
              <td>
                <button class="btn ${btnClass} btn-sm btn-toggle-role" data-user-id="${u.id}" data-target-role="${toggleRoleAction}">
                  ${btnLabel}
                </button>
              </td>
            </tr>
          `;
        }).join('');

        tbody.querySelectorAll('.btn-toggle-role').forEach((btn) => {
          btn.addEventListener('click', async () => {
            const userId = btn.dataset.userId;
            const role = btn.dataset.targetRole;
            try {
              const patchRes = await fetch(`/api/admin/users/${userId}/role`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ role }),
              });
              if (patchRes.ok) {
                showToast(`Role pengguna berhasil diubah menjadi ${role}`, 'success');
                loadAdminData();
              } else {
                showToast('Gagal mengubah role', 'error');
              }
            } catch (err) {
              showToast('Error koneksi', 'error');
            }
          });
        });
      }
    }

    if (statusRes.ok) {
      const statusData = await statusRes.json();
      if (statusData.sessionCache) {
        if (cacheSessionsEl) cacheSessionsEl.textContent = `${statusData.sessionCache.totalCachedInMemory || 0} Sesi`;
        if (cacheHitrateEl) cacheHitrateEl.textContent = `${statusData.sessionCache.hitRatePercent || 100}%`;
      }
    }

    // Muat juga Riwayat Audit Trail
    await loadAdminAuditLogs();
  } catch (err) {
    console.error('Error load admin data:', err);
  }
}

async function loadAdminAuditLogs() {
  const tbody = document.getElementById('admin-audit-tbody');
  if (!tbody) return;

  try {
    const res = await fetch('/api/admin/audit-logs');
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center">Gagal memuat log audit</td></tr>';
      return;
    }

    const { logs } = await res.json();
    if (!logs || logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="4" class="text-center">Belum ada riwayat aktivitas tercatat</td></tr>';
      return;
    }

    tbody.innerHTML = logs.map((log) => {
      const date = new Date(log.createdAt);
      const timeStr = date.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
      const dateStr = date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });

      let badgeColor = 'var(--primary)';
      let badgeLabel = log.eventType;
      if (log.eventType === 'TASK_CREATE') {
        badgeColor = '#10B981';
        badgeLabel = '📝 Tugas Dibuat';
      } else if (log.eventType === 'TASK_COMPLETE') {
        badgeColor = '#3B82F6';
        badgeLabel = '✅ Tugas Selesai';
      } else if (log.eventType === 'TASK_STATUS_UPDATE') {
        badgeColor = '#6366F1';
        badgeLabel = '🔄 Update Status';
      } else if (log.eventType === 'TASK_DELETE') {
        badgeColor = '#EF4444';
        badgeLabel = '🗑️ Tugas Dihapus';
      } else if (log.eventType === 'ROLE_CHANGE') {
        badgeColor = '#F59E0B';
        badgeLabel = '👑 Ubah Role';
      } else if (log.eventType === 'ANNOUNCEMENT_BROADCAST') {
        badgeColor = '#8B5CF6';
        badgeLabel = '📢 Siaran Pengumuman';
      } else if (log.eventType === 'CACHE_FLUSH') {
        badgeColor = '#EC4899';
        badgeLabel = '🧹 Flush Cache';
      }

      let detailStr = '';
      if (log.metadata) {
        if (log.metadata.title) detailStr += `<strong>${escapeHtml(log.metadata.title)}</strong> `;
        if (log.metadata.course) detailStr += `(${escapeHtml(log.metadata.course)}) `;
        if (log.metadata.newRole) detailStr += `Role: <code>${log.metadata.newRole}</code> `;
        if (log.metadata.sentCount) detailStr += `Terkirim ke ${log.metadata.sentCount} server `;
        if (log.metadata.flushedBy) detailStr += `Oleh: ${escapeHtml(log.metadata.flushedBy)} `;
      }

      return `
        <tr>
          <td><span style="font-size: 0.8rem; color: var(--text-dim);">${dateStr} ${timeStr}</span></td>
          <td>
            <div style="display: flex; align-items: center; gap: 0.5rem;">
              <img src="https://api.dicebear.com/7.x/bottts/svg?seed=${encodeURIComponent(log.user?.username || 'user')}" width="22" height="22" style="border-radius: 50%;">
              <strong>${escapeHtml(log.user?.username || 'System')}</strong>
            </div>
          </td>
          <td>
            <span style="display: inline-block; padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.72rem; font-weight: 600; background: ${badgeColor}22; color: ${badgeColor}; border: 1px solid ${badgeColor}44;">
              ${badgeLabel}
            </span>
          </td>
          <td><span style="font-size: 0.82rem; color: var(--text-muted);">${detailStr || '-'}</span></td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    console.error('Error load audit logs:', err);
    tbody.innerHTML = '<tr><td colspan="4" class="text-center">Gagal memuat log aktivitas</td></tr>';
  }
}

// ==========================================
// 9. PWA & Web Push Notification Handlers
// ==========================================
let deferredPrompt = null;
function setupPWA() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('PWA ServiceWorker registration failed:', err);
    });
  }

  const btnPwa = document.getElementById('btn-pwa-install');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (btnPwa) btnPwa.style.display = 'inline-flex';
  });

  if (btnPwa) {
    btnPwa.addEventListener('click', async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        btnPwa.style.display = 'none';
        showToast('🎉 Aplikasi TaskFlow berhasil dipasang di perangkat Anda!', 'success');
      }
      deferredPrompt = null;
    });
  }
}

function setupNotifications() {
  const btnNotif = document.getElementById('btn-toggle-notif');
  const notifIcon = document.getElementById('notif-icon');

  function updateIcon() {
    if (!('Notification' in window)) {
      if (btnNotif) btnNotif.style.display = 'none';
      return;
    }
    if (Notification.permission === 'granted') {
      if (notifIcon) notifIcon.textContent = '🔔';
      if (btnNotif) btnNotif.title = 'Notifikasi Desktop Aktif (Klik untuk kirim notifikasi uji coba)';
    } else {
      if (notifIcon) notifIcon.textContent = '🔕';
      if (btnNotif) btnNotif.title = 'Aktifkan Notifikasi Pengingat Tugas di Layar';
    }
  }

  updateIcon();

  if (btnNotif) {
    btnNotif.addEventListener('click', async () => {
      if (!('Notification' in window)) {
        showToast('Browser Anda belum mendukung notifikasi desktop', 'error');
        return;
      }

      if (Notification.permission === 'granted') {
        sendBrowserNotification('🔔 TaskFlow Notifikasi Aktif', {
          body: 'Notifikasi browser telah aktif! Peringatan deadline tugas kuliah akan muncul langsung di layar Anda.',
        });
        showToast('Notifikasi browser aktif!', 'info');
      } else if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        updateIcon();
        if (perm === 'granted') {
          sendBrowserNotification('✅ Notifikasi Berhasil Diaktifkan', {
            body: 'Kamu akan menerima peringatan deadline tugas dan pengumuman mendesak.',
          });
          showToast('Izin notifikasi desktop berhasil diberikan!', 'success');
        } else {
          showToast('Izin notifikasi ditolak oleh browser', 'warning');
        }
      } else {
        showToast('Izin notifikasi dinonaktifkan di pengaturan browser Anda', 'warning');
      }
    });
  }
}

function sendBrowserNotification(title, options = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    const notif = new Notification(title, {
      icon: 'https://api.dicebear.com/7.x/bottts/svg?seed=taskflow',
      badge: 'https://api.dicebear.com/7.x/bottts/svg?seed=taskflow',
      ...options,
    });
    notif.onclick = () => {
      window.focus();
      notif.close();
    };
  } catch (err) {
    console.warn('Gagal memicu browser notification:', err);
  }
}

// Start app
document.addEventListener('DOMContentLoaded', initApp);

