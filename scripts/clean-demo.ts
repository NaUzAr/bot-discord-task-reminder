import { prisma } from '../src/database/prisma';
import { env } from '../src/config/env';
import { logger } from '../src/shared/utils/logger';

async function cleanDemoData() {
  console.log('🧹 Memulai pembersihan data akun & tugas demo...');

  const demoDiscordIds = ['1001', '1002', '1003', '1004', '1005', 'demo-student-id', 'web-user'];

  // 1. Hapus tasks dari SEED_DATA
  const deletedSeedTasks = await prisma.task.deleteMany({
    where: {
      OR: [
        { sourceType: 'SEED_DATA' },
        { user: { discordId: { in: demoDiscordIds } } },
      ],
    },
  });
  console.log(`✅ Berhasil menghapus ${deletedSeedTasks.count} tugas demo.`);

  // 2. Hapus akun demo
  const deletedUsers = await prisma.user.deleteMany({
    where: {
      discordId: { in: demoDiscordIds },
    },
  });
  console.log(`✅ Berhasil menghapus ${deletedUsers.count} akun mahasiswa demo.`);

  // 3. Update status ADMIN untuk akun Discord asli
  const adminIds = env.ADMIN_DISCORD_IDS
    ? env.ADMIN_DISCORD_IDS.split(',').map((id: string) => id.trim()).filter(Boolean)
    : ['388612656678043649'];

  const updatedAdmins = await prisma.user.updateMany({
    where: {
      discordId: { in: adminIds },
    },
    data: {
      role: 'ADMIN',
    },
  });
  console.log(`👑 Berhasil menetapkan ${updatedAdmins.count} user sebagai ADMIN (${adminIds.join(', ')}).`);

  // Tampilkan sisa user asli di DB
  const remainingUsers = await prisma.user.findMany({
    select: {
      id: true,
      discordId: true,
      username: true,
      role: true,
      xp: true,
    },
  });
  console.log('\n📋 Daftar Mahasiswa / Pengguna Aktif Riil di Database:');
  console.table(remainingUsers);

  console.log('✨ Pembersihan selesai!');
}

cleanDemoData()
  .catch((err) => {
    logger.error({ err }, 'Gagal membersihkan data demo');
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
