import { deployCommands } from '../src/bot/deploy-commands';
import { env } from '../src/config/env';
import { logger } from '../src/shared/utils/logger';

async function main() {
  logger.info('🚀 Triggering manual slash commands deployment...');
  await deployCommands(env.CLIENT_ID, [env.GUILD_ID]);
  logger.info('✅ Deployment completed successfully!');
  process.exit(0);
}

main().catch((err) => {
  logger.error({ err }, 'Deploy script failed');
  process.exit(1);
});
