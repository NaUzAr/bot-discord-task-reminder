import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * 🌱 Seed Script: Mengisi database dengan data demo realistis
 * Jalankan: npx tsx prisma/seed.ts
 */
async function main() {
  console.log('🌱 Memulai seeding database TaskFlow OS...\n');

  // =============================
  // 1. Buat User (Mahasiswa Demo)
  // =============================
  const users = await Promise.all([
    prisma.user.upsert({
      where: { discordId: '1001' },
      update: {},
      create: {
        discordId: '1001',
        username: 'Naufal Rizky',
        xp: 1250,
        streak: 12,
        lastActiveAt: new Date(),
      },
    }),
    prisma.user.upsert({
      where: { discordId: '1002' },
      update: {},
      create: {
        discordId: '1002',
        username: 'Raka Pratama',
        xp: 980,
        streak: 7,
        lastActiveAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
      },
    }),
    prisma.user.upsert({
      where: { discordId: '1003' },
      update: {},
      create: {
        discordId: '1003',
        username: 'Dimas Aditya',
        xp: 720,
        streak: 5,
        lastActiveAt: new Date(Date.now() - 8 * 60 * 60 * 1000),
      },
    }),
    prisma.user.upsert({
      where: { discordId: '1004' },
      update: {},
      create: {
        discordId: '1004',
        username: 'Sari Dewi',
        xp: 540,
        streak: 3,
        lastActiveAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      },
    }),
    prisma.user.upsert({
      where: { discordId: '1005' },
      update: {},
      create: {
        discordId: '1005',
        username: 'Andi Wijaya',
        xp: 350,
        streak: 1,
        lastActiveAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
      },
    }),
  ]);

  console.log(`✅ ${users.length} Mahasiswa berhasil dibuat/diupdate.`);

  // =============================
  // 2. Buat Guild (Server Discord Demo)
  // =============================
  const guild = await prisma.guild.upsert({
    where: { discordGuildId: 'demo-guild-001' },
    update: {},
    create: {
      discordGuildId: 'demo-guild-001',
      name: 'Kelas Teknik Informatika 2024',
    },
  });
  console.log(`✅ Guild "${guild.name}" berhasil dibuat.`);

  // =============================
  // 3. Buat Task (Tugas Kuliah Realistis)
  // =============================
  const now = new Date();
  const hour = (h: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate(), h, 0, 0);
  const daysFromNow = (d: number, h: number = 23, m: number = 59) => {
    const date = new Date(now);
    date.setDate(date.getDate() + d);
    date.setHours(h, m, 0, 0);
    return date;
  };

  // Hapus tugas demo lama sebelum insert baru
  await prisma.subtask.deleteMany({ where: { task: { sourceType: 'SEED_DATA' } } });
  await prisma.reminder.deleteMany({ where: { task: { sourceType: 'SEED_DATA' } } });
  await prisma.task.deleteMany({ where: { sourceType: 'SEED_DATA' } });

  const tasksData = [
    // === OVERDUE (sudah terlewat) ===
    {
      userId: users[0].id, guildId: guild.id, title: 'Laporan Praktikum Fisika Dasar',
      description: 'Format: PDF, minimal 10 halaman. Sertakan data pengukuran, analisis grafik, dan kesimpulan.',
      status: 'TODO' as const, priority: 'HIGH' as const,
      dueAt: daysFromNow(-1, 23, 59), taskType: 'INDIVIDUAL',
      subtasks: ['Buat cover & daftar isi', 'Tulis dasar teori', 'Input data pengukuran', 'Buat grafik analisis', 'Tulis kesimpulan'],
    },
    // === DEADLINE HARI INI ===
    {
      userId: users[0].id, guildId: guild.id, title: 'Quiz Online Kalkulus II - Integral Lipat',
      description: 'Quiz via Google Form, 20 soal pilihan ganda. Waktu: 60 menit.',
      status: 'TODO' as const, priority: 'URGENT' as const,
      dueAt: hour(21), taskType: 'INDIVIDUAL',
    },
    {
      userId: users[1].id, guildId: guild.id, title: 'Presentasi Kelompok Sistem Pakar',
      description: 'Slide PPT minimal 15 slide. Topik: Forward Chaining & Backward Chaining. Demo program wajib.',
      status: 'IN_PROGRESS' as const, priority: 'HIGH' as const,
      dueAt: hour(19), taskType: 'GROUP', assignedUserIds: [users[1].discordId, users[2].discordId, users[3].discordId],
      subtasks: ['Buat slide teori Forward/Backward Chaining', 'Koding demo program Python', 'Latihan presentasi bersama'],
    },
    // === DEADLINE BESOK ===
    {
      userId: users[0].id, guildId: guild.id, title: 'Tugas Pemrograman Web - CRUD Laravel',
      description: 'Buat aplikasi CRUD sederhana menggunakan Laravel 11. Upload ke GitHub dan deploy ke Heroku/Railway.',
      status: 'IN_PROGRESS' as const, priority: 'HIGH' as const,
      dueAt: daysFromNow(1, 23, 59), taskType: 'INDIVIDUAL',
      linkUrl: 'https://elearning.kampus.ac.id/mod/assign/view.php?id=12345',
      subtasks: ['Setup project Laravel', 'Buat migration & model', 'Buat controller CRUD', 'Buat view Blade', 'Deploy ke Railway', 'Tulis README.md'],
    },
    {
      userId: users[2].id, guildId: guild.id, title: 'Makalah Etika Profesi - AI & Privasi Data',
      description: 'Format: Makalah ilmiah, minimal 3000 kata. Gunakan minimal 5 referensi jurnal internasional.',
      status: 'TODO' as const, priority: 'MEDIUM' as const,
      dueAt: daysFromNow(1, 20, 0), taskType: 'INDIVIDUAL',
    },
    // === DEADLINE MINGGU INI ===
    {
      userId: users[0].id, guildId: guild.id, title: 'Proyek Akhir IoT - Smart Greenhouse Monitoring',
      description: 'Sensor DHT22 + ESP32 + Firebase. Tampilkan data suhu & kelembaban real-time di dashboard web.',
      status: 'IN_PROGRESS' as const, priority: 'URGENT' as const,
      dueAt: daysFromNow(4, 23, 59), taskType: 'GROUP', assignedUserIds: [users[0].discordId, users[1].discordId],
      subtasks: ['Rangkai sensor DHT22 + ESP32', 'Program Arduino baca sensor', 'Setup Firebase Realtime DB', 'Buat dashboard web React', 'Testing & dokumentasi', 'Buat video demo'],
    },
    {
      userId: users[3].id, guildId: guild.id, title: 'Laporan Kerja Praktik - Bab 3 Metodologi',
      description: 'Bab 3: Metodologi Penelitian. Jelaskan metode waterfall, diagram alir, dan use case diagram.',
      status: 'TODO' as const, priority: 'MEDIUM' as const,
      dueAt: daysFromNow(5, 17, 0), taskType: 'INDIVIDUAL',
    },
    {
      userId: users[1].id, guildId: guild.id, title: 'UTS Basis Data - Persiapan & Latihan Soal',
      description: 'Materi: Normalisasi (1NF-BCNF), SQL JOIN, Subquery, dan ERD.',
      status: 'TODO' as const, priority: 'HIGH' as const,
      dueAt: daysFromNow(6, 8, 0), taskType: 'INDIVIDUAL',
      subtasks: ['Review materi normalisasi', 'Latihan soal SQL JOIN', 'Latihan soal subquery', 'Buat ringkasan cheat sheet'],
    },
    // === DEADLINE NANTI (> 7 hari) ===
    {
      userId: users[0].id, guildId: guild.id, title: 'Skripsi - Bab 1 Pendahuluan (Draft)',
      description: 'Tulis latar belakang, rumusan masalah, tujuan penelitian, dan batasan masalah.',
      status: 'TODO' as const, priority: 'LOW' as const,
      dueAt: daysFromNow(14, 23, 59), taskType: 'INDIVIDUAL',
    },
    {
      userId: users[4].id, guildId: guild.id, title: 'Tugas Statistika - Regresi Linear Berganda',
      description: 'Gunakan SPSS atau Python untuk analisis regresi. Sertakan interpretasi output.',
      status: 'TODO' as const, priority: 'MEDIUM' as const,
      dueAt: daysFromNow(10, 23, 59), taskType: 'INDIVIDUAL',
    },
    // === TUGAS YANG SUDAH SELESAI ===
    {
      userId: users[0].id, guildId: guild.id, title: 'Laporan Akhir Jaringan Komputer',
      description: 'Konfigurasi VLAN, Routing OSPF, dan Firewall di Cisco Packet Tracer.',
      status: 'DONE' as const, priority: 'HIGH' as const,
      dueAt: daysFromNow(-3, 23, 59), taskType: 'INDIVIDUAL',
      completedAt: daysFromNow(-3, 18, 30),
    },
    {
      userId: users[1].id, guildId: guild.id, title: 'Quiz Algoritma & Pemrograman',
      status: 'DONE' as const, priority: 'MEDIUM' as const,
      dueAt: daysFromNow(-2, 10, 0), taskType: 'INDIVIDUAL',
      completedAt: daysFromNow(-2, 9, 45),
    },
    {
      userId: users[2].id, guildId: guild.id, title: 'Resume Jurnal Machine Learning',
      description: 'Resume paper "Attention Is All You Need" (Vaswani et al., 2017).',
      status: 'DONE' as const, priority: 'LOW' as const,
      dueAt: daysFromNow(-5, 23, 59), taskType: 'INDIVIDUAL',
      completedAt: daysFromNow(-5, 20, 0),
    },
  ];

  for (const td of tasksData) {
    const { subtasks: subtaskTitles, ...taskData } = td;

    const task = await prisma.task.create({
      data: {
        ...taskData,
        sourceType: 'SEED_DATA',
        assignedUserIds: taskData.assignedUserIds || [users.find(u => u.id === taskData.userId)!.discordId],
      },
    });

    if (subtaskTitles && subtaskTitles.length > 0) {
      await prisma.subtask.createMany({
        data: subtaskTitles.map((title, idx) => ({
          taskId: task.id,
          title,
          position: idx,
          // Tandai beberapa subtask pertama sebagai DONE agar progress bar terlihat hidup
          status: idx < Math.floor(subtaskTitles.length * 0.4) ? 'DONE' : 'TODO',
          completedAt: idx < Math.floor(subtaskTitles.length * 0.4) ? new Date() : null,
        })),
      });
    }
  }

  console.log(`✅ ${tasksData.length} Tugas kuliah berhasil dibuat (termasuk subtasks).`);

  // =============================
  // 4. Buat Focus Sessions (Riwayat Pomodoro)
  // =============================
  const focusData = [
    { userId: users[0].id, durationMinutes: 50, hoursAgo: 2 },
    { userId: users[0].id, durationMinutes: 25, hoursAgo: 5 },
    { userId: users[0].id, durationMinutes: 25, hoursAgo: 26 },
    { userId: users[1].id, durationMinutes: 50, hoursAgo: 3 },
    { userId: users[1].id, durationMinutes: 25, hoursAgo: 28 },
    { userId: users[2].id, durationMinutes: 25, hoursAgo: 10 },
    { userId: users[3].id, durationMinutes: 50, hoursAgo: 48 },
    { userId: users[4].id, durationMinutes: 25, hoursAgo: 72 },
  ];

  for (const f of focusData) {
    const startedAt = new Date(Date.now() - f.hoursAgo * 60 * 60 * 1000);
    const endedAt = new Date(startedAt.getTime() + f.durationMinutes * 60 * 1000);
    await prisma.focusSession.create({
      data: {
        userId: f.userId,
        startedAt,
        endedAt,
        durationMinutes: f.durationMinutes,
      },
    });
  }

  console.log(`✅ ${focusData.length} Focus session (Pomodoro) berhasil dicatat.`);

  // =============================
  // 5. Buat Activity Logs
  // =============================
  const logTypes = ['TASK_CREATED', 'TASK_COMPLETED', 'FOCUS_START', 'FOCUS_END', 'REMINDER_SENT'];
  for (let i = 0; i < 20; i++) {
    await prisma.activityLog.create({
      data: {
        userId: users[i % users.length].id,
        eventType: logTypes[i % logTypes.length],
        metadata: { source: 'seed', index: i },
        createdAt: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000),
      },
    });
  }

  console.log('✅ 20 Activity logs berhasil dicatat.\n');
  console.log('🎉 Seeding selesai! Database TaskFlow OS siap untuk demo.');
  console.log('   Buka http://localhost:3000 untuk melihat dashboard.');
}

main()
  .catch((e) => {
    console.error('❌ Seed gagal:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
