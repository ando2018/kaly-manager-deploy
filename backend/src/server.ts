import http from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { initSockets } from './sockets/io';
import { migrateLegacyDataIfNeeded } from './data/migrate-legacy';
import { initPlatformStore } from './data/platform';
import { initSubscriptionsStore } from './data/subscriptions';
import { initContactMessagesStore } from './data/contact-messages';

async function main(): Promise<void> {
  // Platform-wide data (établissements, abonnements/tokens, messages) lives in its own Firebase
  // project — must be loaded before anything else touches it, including the legacy-data migration.
  await Promise.all([initPlatformStore(), initSubscriptionsStore(), initContactMessagesStore()]);

  migrateLegacyDataIfNeeded();

  const app = createApp();
  const httpServer = http.createServer(app);

  initSockets(httpServer);

  httpServer.listen(config.port, () => {
    console.log(`Kaly Manager API listening on http://localhost:${config.port}`);
  });
}

main().catch((err) => {
  console.error('\nÉchec du démarrage du serveur.');
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
