#!/bin/bash
# ==============================================================================
# TaskFlow OS - Automated VPS Deployment Script
# ==============================================================================

set -e

echo "🚀 Starting TaskFlow OS Deployment..."

# 1. Pastikan file .env tersedia
if [ ! -f .env ]; then
  echo "⚠️  File .env tidak ditemukan!"
  if [ -f .env.example ]; then
    echo "📋 Membuat template .env dari .env.example..."
    cp .env.example .env
    echo "❗ Silakan edit file .env terlebih dahulu (nano .env) dengan token Discord & API key Anda!"
    exit 1
  else
    echo "❌ .env.example tidak ditemukan. Harap siapkan .env sebelum melanjutkan."
    exit 1
  fi
fi

# 2. Ambil update terbaru dari GitHub jika dalam git repository
if [ -d .git ]; then
  echo "📥 Menarik update terbaru dari GitHub..."
  git pull origin main
fi

# 3. Build & Jalankan Docker Container
echo "🐳 Membangun dan menjalankan container Docker..."
docker compose down --remove-orphans || true
docker compose up -d --build

# 4. Tunggu container siap
echo "⏳ Memeriksa status container..."
sleep 5

# 5. Tampilkan status
docker compose ps

echo ""
echo "🎉 Deployment selesai!"
echo "👉 Untuk melihat log aplikasi:"
echo "   docker compose logs -f bot"
echo ""
echo "👉 Untuk seed data demo lomba:"
echo "   docker compose exec bot npm run db:seed"
