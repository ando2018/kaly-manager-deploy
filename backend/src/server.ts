import http from 'node:http';
import { createApp } from './app';
import { config } from './config';
import { initSockets } from './sockets/io';
import { initPlatformStore } from './data/platform';
import { connectMongo } from './data/mongo';
import { initSubscriptionsStore } from './data/subscriptions';
import { initContactMessagesStore } from './data/contact-messages';

async function main(): Promise<void> {
  // Everything lives in MongoDB (MONGODB_URI in backend/.env) — the platform documents (établissements,
  // plans & tokens, messages) must be loaded before anything else touches them.
  await connectMongo();
  await Promise.all([initPlatformStore(), initSubscriptionsStore(), initContactMessagesStore()]);

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
