<div align="center">

# ⚡ TaskFlow OS
### *Intelligent Discord Bot & Web Ecosystem for Student Productivity*

[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org/)
[![Discord.js](https://img.shields.io/badge/Discord.js-v14-5865F2?logo=discord&logoColor=white)](https://discord.js.org/)
[![Prisma ORM](https://img.shields.io/badge/Prisma-PostgreSQL-2D3748?logo=prisma&logoColor=white)](https://www.prisma.io/)
[![BullMQ & Redis](https://img.shields.io/badge/BullMQ-Redis-DC382D?logo=redis&logoColor=white)](https://bullmq.io/)
[![Google Gemini AI](https://img.shields.io/badge/Google_Gemini-Flash_3.x-8E75C2?logo=google&logoColor=white)](https://ai.google.dev/)
[![Docker Ready](https://img.shields.io/badge/Docker-Compose-2496ED?logo=docker&logoColor=white)](https://www.docker.com/)

**TaskFlow OS** adalah platform produktivitas mahasiswa terpadu yang memadukan kekuatan **Discord Bot berbasis AI** dengan **Web Dashboard Modern (Glassmorphism UI)** untuk mengakhiri krisis *procrastination*, tugas terlewat, dan disorganisasi tugas kuliah.

[Demo Fitur](#-fitur-utama) • [Arsitektur Sistem](#-arsitektur-sistem) • [Panduan Instalasi](#-panduan-instalasi--menjalankan) • [Deploy ke VPS](#-panduan-deploy-vps) • [Dokumentasi API](#-dokumentasi-web-api)

---

</div>

## 🌟 Masalah & Solusi

Mahasiswa kerap menghadapi masalah:
1. **Pengumuman tugas tersebar** di puluhan grup chat tanpa struktur jelas.
2. **Lupa deadline** akibat sistem pengingat tradisional yang pasif atau hanya bunyi di menit-menit akhir.
3. **Koordinasi kelompok kacau**, tidak jelas siapa mengerjakan apa.
4. **Kurang motivasi belajar** saat mengerjakan tugas mandiri.

**TaskFlow OS menjawabnya secara komprehensif:**
- 🧠 **AI Task Extractor:** Salin pengumuman dosen yang berantakan, AI Gemini langsung mengekstrak judul, deadline, mata kuliah, checklist sub-tugas, prioritas, hingga tautan submit.
- ⏰ **Tiered Proactive Reminders:** Pengingat 3 tahap berjenjang otomatis (H-24 Jam, H-3 Jam, dan H-30 Menit) menggunakan distributed queue (BullMQ + Redis).
- 📊 **Dual Interface:** Akses fleksibel langsung dari Discord (Slash Commands, Embeds, Buttons) maupun Web Dashboard interaktif.
- 🎮 **Gamification & Focus:** Pomodoro focus timer terintegrasi, reward XP, streak harian, dan leaderboard kelas.

---

## 🚀 Fitur Utama

### 1. 🧠 AI Smart Task Extraction (Powered by Google Gemini)
* Cukup ketik `/tugas-ai [teks pesan]` atau klik kanan pesan Discord (Context Menu: *Ekstrak Tugas AI*).
* AI secara cerdas memahami format bahasa Indonesia kasual, singkatan, tanggal relatif (*"besok jam 23.59"*, *"selasa depan"*), dan menghasilkan JSON terstruktur.
* Otomatis memecah rincian tugas menjadi **sub-tugas checklist** mandiri.

### 2. ⏰ 3-Stage Tiered Reminder Engine (BullMQ + Redis)
Tidak ada lagi alasan *"lupa deadline"*:
* **Stage 1 (H-24 Jam):** Notifikasi evaluasi awal — *"Deadline besok, pastikan mulai mencicil!"*
* **Stage 2 (H-3 Jam):** Notifikasi peringatan hitung mundur — *"3 jam lagi, segera rapikan!"*
* **Stage 3 (H-30 Menit):** Final Call — *"30 menit lagi, submit file sekarang!"*

### 3. 🌐 Modern Web Dashboard (Port 3000)
* **Glassmorphism Aesthetic:** Antarmuka gelap elegan dengan neon accent, transisi halus, dan responsif.
* **Deadline Radar:** Panel visual status tenggat waktu (Overdue, Hari Ini, Besok, Minggu Ini).
* **Kanban Board Interaktif:** Kolom Todo, Sedang Dikerjakan, dan Selesai dengan aksi instan & progress bar sub-tugas.
* **Integrated Pomodoro Timer:** Timer fokus dengan pilihan 25/50 menit, sinkronisasi otomatis XP ke database.
* **Leaderboard Kelas & Podium:** Tampilan Top 3 podium mahasiswa paling produktif.
* **Discord OAuth2 & Demo Mode:** Login aman menggunakan akun Discord atau Switch Akun Demo 1-klik untuk presentasi lomba.

### 4. 👥 Manajemen Tugas Kelompok & Individu
* Dukungan tugas `INDIVIDUAL` dan `GROUP`.
* Multi-assignee mention (`@anggota1 @anggota2`) dengan sinkronisasi notifikasi ke semua pihak yang terlibat.

### 5. 📅 1-Click Google Calendar Sync
* Tombol instan di Discord Embed dan Web Dashboard yang langsung membuka Google Calendar dengan judul, durasi, deskripsi, dan link pengumpulan yang sudah terisi otomatis.

### 6. 🌅 Daily Morning Briefing (07:00 WIB)
* Cron scheduler otomatis yang mengirimkan ringkasan tugas harian ke channel Discord setiap pagi pukul 07:00 WIB.

---

## 🏛️ Arsitektur Sistem

TaskFlow OS mengusung arsitektur **Modular Monolith** berperforma tinggi:

```
                          ┌─────────────────────────────┐
                          │   Discord Client (User)     │
                          └──────────────┬──────────────┘
                                         │ Slash Commands / Context Menu
                                         ▼
┌─────────────────────────┐       ┌─────────────────────────────┐       ┌────────────────────────┐
│  Modern Web Dashboard   │◄─────►│    TaskFlow Core Engine     │◄─────►│   Google Gemini AI     │
│  (Express + Vanilla JS) │ HTTP  │       (TypeScript)          │  SDK  │ (3.5 / 3.8 Flash)      │
└─────────────────────────┘       └──────┬───────────────┬──────┘       └────────────────────────┘
                                         │               │
                                         ▼               ▼
                          ┌─────────────────────┐  ┌─────────────────────┐
                          │ PostgreSQL (Prisma) │  │   Redis + BullMQ    │
                          │   Stateful Storage  │  │  Distributed Delay  │
                          └─────────────────────┘  └─────────────────────┘
```

---

## 📦 Tech Stack

| Komponen | Teknologi | Keterangan |
|---|---|---|
| **Runtime** | Node.js (v20+) + TypeScript 5 | Strict typing, scalable, ESM/CJS hybrid |
| **Bot Framework** | Discord.js v14 | Slash commands, Context Menu, Modal, Components |
| **AI Engine** | Google Gemini API (Flash Models) | Ekstraksi NLP presisi dengan fallback model |
| **Database** | PostgreSQL 16 + Prisma ORM | Relational schema, migration, type-safe queries |
| **Job Queue** | BullMQ + Redis 7 | Precision delayed reminders & recurring jobs |
| **Web Server** | Express 5 | REST API + Single Page Application |
| **Frontend** | HTML5, Vanilla CSS (Glassmorphism), ES6 JS | Zero bloat, ultra cepat (<50ms load time) |
| **Testing** | Vitest | Unit testing untuk AI schema, utils, & business logic |
| **Container** | Docker & Docker Compose | Multi-container setup siap produksi |

---

## 🛠️ Panduan Instalasi & Menjalankan

### Prasyarat
- [Node.js](https://nodejs.org/) v20 atau lebih baru
- [Docker & Docker Compose](https://www.docker.com/) (opsional jika menjalankan database lokal)
- Token Bot Discord ([Discord Developer Portal](https://discord.com/developers/applications))
- Google Gemini API Key ([Google AI Studio](https://aistudio.google.com/))

### 1. Kloning Repositori & Install Dependensi
```bash
git clone https://github.com/NaUzAr/bot-discord-task-reminder.git
cd bot-discord-task-reminder
npm install
```

### 2. Konfigurasi Environment Variable (`.env`)
Salin berkas `.env.example` menjadi `.env` dan isi kredensial Anda:
```env
BOT_TOKEN=your_discord_bot_token
CLIENT_ID=your_discord_client_id
GUILD_ID=your_test_guild_id

DATABASE_URL="postgresql://postgres:123@localhost:5432/taskflow_db?schema=public"
REDIS_URL="redis://localhost:56379"

GEMINI_API_KEY=your_gemini_api_key
LOG_LEVEL=info

PORT=3000
DISCORD_CLIENT_SECRET=your_oauth2_client_secret
WEB_BASE_URL=http://localhost:3000
```

> **Catatan OAuth2 Discord:**
> Pada Discord Developer Portal > **OAuth2** > **Redirects**, tambahkan URL:
> `http://localhost:3000/auth/callback`

### 3. Jalankan Database & Redis (Docker Compose)
```bash
docker compose up -d postgres redis
```

### 4. Sinkronisasi Skema Database & Data Demo Realistis
```bash
# Push schema Prisma ke database
npm run db:push

# Isi database dengan data demo mahasiswa & tugas realistis
npm run db:seed
```

### 5. Deploy Slash Commands & Jalankan Aplikasi
```bash
# Daftarkan slash commands ke Discord
npx tsx src/bot/deploy-commands.ts

# Jalankan dalam mode development
npm run dev
```

Buka **`http://localhost:3000`** di browser Anda untuk menikmati Web Dashboard!

---

## 🌐 Panduan Deploy VPS

Untuk panduan lengkap langkah demi langkah deploy ke VPS (Ubuntu/Debian) menggunakan Docker & Nginx Reverse Proxy, lihat file panduan khusus:
👉 **[VPS_DEPLOYMENT.md](file:///d:/0000.%20KULIAH%20PART%202/LOMBAA%20COY/discort-bot-task-reminder/VPS_DEPLOYMENT.md)**

### Perintah Cepat Deploy di VPS:
```bash
# 1. Clone repository
git clone https://github.com/NaUzAr/bot-discord-task-reminder.git
cd bot-discord-task-reminder

# 2. Siapkan file konfigurasi .env
cp .env.example .env
nano .env

# 3. Jalankan script deploy otomatis
chmod +x deploy.sh
./deploy.sh
```

---

## 🧪 Menjalankan Unit Tests

Proyek ini dilengkapi rangkaian pengujian unit otomatis menggunakan **Vitest**:
```bash
npm test
```

Mencakup verifikasi:
* ✅ Generator URL sinkronisasi Google Calendar
* ✅ Parser & Sanitisasi Zod Schema untuk Google Gemini AI Task Extraction
* ✅ Validasi fallback prioritas & penanganan input kotor

---

## 🌐 Dokumentasi Web API

Dashboard berkomunikasi melalui REST API internal:

| Method | Endpoint | Deskripsi |
|---|---|---|
| `GET` | `/api/status` | Metrik kesehatan Bot (ping, server, uptime), DB, & Queue |
| `GET` | `/api/tasks` | Mengambil seluruh daftar tugas beserta sub-tugas |
| `POST` | `/api/tasks` | Membuat tugas baru dari Web UI |
| `PATCH` | `/api/tasks/:id/status` | Mengubah status tugas (`TODO`, `IN_PROGRESS`, `DONE`) |
| `DELETE` | `/api/tasks/:id` | Menghapus tugas |
| `GET` | `/api/radar` | Data agregasi Deadline Radar (Overdue, Today, Tomorrow, Week) |
| `GET` | `/api/leaderboard` | Peringkat produktivitas mahasiswa, XP, dan streak |
| `POST` | `/api/focus/log` | Mencatat sesi Pomodoro dan mengklaim bonus XP |
| `GET` | `/auth/user` | Mendapatkan profil sesi pengguna yang sedang aktif |
| `POST` | `/auth/demo-switch` | Mengganti profil pengguna demo saat presentasi |

---

## 👥 Tim Pengembang

Dikembangkan dengan dedikasi tinggi untuk perlombaan inovasi teknologi mahasiswa.

* **Repository:** [NaUzAr/bot-discord-task-reminder](https://github.com/NaUzAr/bot-discord-task-reminder)
* **Lisensi:** ISC License
