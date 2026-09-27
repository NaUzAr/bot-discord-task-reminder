# 🚀 Panduan Lengkap Deploy TaskFlow OS ke VPS

Panduan langkah demi langkah untuk melakukan deploy **TaskFlow OS** ke Virtual Private Server (VPS) berbasis Linux (Ubuntu 20.04/22.04/24.04 atau Debian).

---

## 📋 Prasyarat di VPS
- VPS dengan RAM minimal 1 GB (disarankan 2 GB atau aktifkan 2 GB Swap).
- Port terbuka di firewall VPS:
  - `3000` (Web Dashboard & Discord OAuth2)
  - `80` & `443` (Jika ingin menggunakan domain + Nginx SSL)

---

## 🛠️ Langkah 1: Install Docker & Docker Compose di VPS

Jika VPS Anda belum terinstall Docker, jalankan satu baris perintah instalasi resmi:

```bash
curl -fsSL https://get.docker.com -o get-docker.sh && sh get-docker.sh
```

Aktifkan Docker agar otomatis berjalan saat VPS reboot:
```bash
sudo systemctl enable --now docker
```

---

## 📥 Langkah 2: Kloning Repositori dari GitHub

Masuk ke direktori home atau `/opt`:
```bash
cd ~
git clone https://github.com/NaUzAr/bot-discord-task-reminder.git
cd bot-discord-task-reminder
```

---

## ⚙️ Langkah 3: Konfigurasi File `.env`

Salin template konfigurasi:
```bash
cp .env.example .env
nano .env
```

Sesuaikan nilai-nilainya:
```env
# Discord Settings
BOT_TOKEN=token_bot_discord_anda
CLIENT_ID=client_id_aplikasi_discord
GUILD_ID=id_server_discord_utama

# Database & Redis (Biarkan default jika menggunakan Docker network bawaan)
DATABASE_URL="postgresql://taskflow_user:taskflow_password@postgres:5432/taskflow_db?schema=public"
REDIS_URL="redis://redis:6379"

# AI Key (Google Gemini)
GEMINI_API_KEY=api_key_gemini_anda

# Web Dashboard
PORT=3000
WEB_BASE_URL=http://IP_VPS_ANDA:3000
# Atau jika sudah punya domain: WEB_BASE_URL=https://taskflow.domainanda.com
DISCORD_CLIENT_SECRET=client_secret_oauth2_discord
ADMIN_DISCORD_IDS=id_discord_akun_anda
```

> ⚠️ **PENTING - Konfigurasi di Discord Developer Portal:**
> 1. Masuk ke **[Discord Developer Portal](https://discord.com/developers/applications)** > Pilih Bot Anda.
> 2. Di tab **Bot**: Pastikan **Message Content Intent**, **Server Members Intent**, dan **Presence Intent** sudah aktif (**ON**).
> 3. Di tab **OAuth2** > **Redirects**: Tambahkan redirect URL:
>    - `http://IP_VPS_ANDA:3000/auth/callback` (atau versi domain HTTPS Anda)
>    - Lalu klik **Save Changes**.

---

## 🚀 Langkah 4: Jalankan Bot & Layanan (1 Command)

Jalankan script deploy otomatis:
```bash
chmod +x deploy.sh
./deploy.sh
```

Atau jalankan perintah manual:
```bash
docker compose up -d --build
```

Docker Compose akan otomatis:
1. Menyalakan database **PostgreSQL 15** dan menunggu sampai siap.
2. Menyalakan **Redis 7** dengan persistent storage.
3. Melakukan sinkronisasi schema database Prisma (`prisma db push`) secara otomatis.
4. Menyalakan bot Discord dan Web Server port `3000`.
5. Mendaftarkan Slash Commands ke Discord secara otomatis saat bot online.

---

## 📊 Langkah 5: Memeriksa Status & Log

Cek apakah semua container berjalan normal:
```bash
docker compose ps
```

Lihat live log bot:
```bash
docker compose logs -f bot
```

---

## 🎮 Langkah 6: (Opsional) Mengisi Data Demo untuk Presentasi/Lomba

Jika Anda ingin mengisi database dengan data demo realistis (tugas mahasiswa, checklist, leaderboard, briefing):
```bash
docker compose exec bot npm run db:seed
```

Jika ingin membersihkan data demo:
```bash
docker compose exec bot npm run db:clean-demo
```

---

## 🔄 Cara Update Kode Terbaru di Kemudian Hari

Setiap kali Anda melakukan `git push` dari komputer lokal, cukup jalankan perintah ini di VPS:

```bash
cd ~/bot-discord-task-reminder
./deploy.sh
```

Atau manual:
```bash
git pull origin main
docker compose up -d --build
```

---

## 🌐 (Opsional) Menggunakan Domain Sendiri dengan Nginx & SSL Certbot

Jika Anda ingin mengakses dashboard lewat domain (contoh `https://taskflow.mydomain.com`):

1. **Install Nginx & Certbot**:
   ```bash
   sudo apt update && sudo apt install -y nginx certbot python3-certbot-nginx
   ```

2. **Buat konfigurasi Nginx**:
   ```bash
   sudo nano /etc/nginx/sites-available/taskflow
   ```
   Isi dengan:
   ```nginx
   server {
       server_name taskflow.mydomain.com;

       location / {
           proxy_pass http://127.0.0.1:3000;
           proxy_http_version 1.1;
           proxy_set_header Upgrade $http_upgrade;
           proxy_set_header Connection 'upgrade';
           proxy_set_header Host $host;
           proxy_cache_bypass $http_upgrade;
           proxy_set_header X-Real-IP $remote_addr;
           proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
           proxy_set_header X-Forwarded-Proto $scheme;
       }
   }
   ```

3. **Aktifkan & Pasang SSL**:
   ```bash
   sudo ln -s /etc/nginx/sites-available/taskflow /etc/nginx/sites-enabled/
   sudo nginx -t
   sudo systemctl restart nginx
   sudo certbot --nginx -d taskflow.mydomain.com
   ```
4. Update `WEB_BASE_URL` di `.env` menjadi `https://taskflow.mydomain.com`, restart container dengan `docker compose restart bot`, dan tambahkan `https://taskflow.mydomain.com/auth/callback` di Discord Developer Portal.
