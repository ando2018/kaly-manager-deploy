import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express, { NextFunction, Request, Response } from 'express';
import { config } from './config';
import { authRouter } from './routes/auth.routes';
import { usersRouter } from './routes/users.routes';
import { menuRouter } from './routes/menu.routes';
import { alertsRouter, ordersRouter } from './routes/orders.routes';
import { uploadsRouter } from './routes/uploads.routes';
import { platformRouter } from './routes/platform.routes';
import { settingsRouter } from './routes/settings.routes';
import { supportRouter } from './routes/support.routes';
import { eventsRouter } from './routes/events.routes';
import { publicOrderRouter } from './routes/public-order.routes';
import { UPLOADS_DISK_PATH, UPLOADS_PUBLIC_PATH } from './middleware/upload.middleware';
import { resolveEtablissement } from './middleware/etablissement.middleware';

// Built Angular app (`npm run build` in frontend/) — served here so the whole app runs on one port.
const FRONTEND_DIST = path.resolve(__dirname, '..', '..', 'frontend', 'dist', 'kaly-manager', 'browser');
const FRONTEND_INDEX = path.join(FRONTEND_DIST, 'index.html');
const hasFrontendBuild = fs.existsSync(FRONTEND_INDEX);


export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());
  app.use(UPLOADS_PUBLIC_PATH, express.static(UPLOADS_DISK_PATH));
  if (hasFrontendBuild) {
    app.use(express.static(FRONTEND_DIST));
  }

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // Platform-level: creating/listing etablissements, or checking an id exists. Not scoped to an établissement.
  app.use('/api/platform', platformRouter);

  // Everything below operates within a single établissement's isolated data, resolved from X-Etablissement-Id.
  app.use('/api/auth', resolveEtablissement, authRouter);
  app.use('/api/users', resolveEtablissement, usersRouter);
  app.use('/api/menu', resolveEtablissement, menuRouter);
  app.use('/api/orders', resolveEtablissement, ordersRouter);
  app.use('/api/alerts', resolveEtablissement, alertsRouter);
  app.use('/api/uploads', resolveEtablissement, uploadsRouter);
  app.use('/api/settings', resolveEtablissement, settingsRouter);
  app.use('/api/support', resolveEtablissement, supportRouter);
  app.use('/api/events', resolveEtablissement, eventsRouter);
  // No requireAuth: a customer scanning a table's QR code has no staff login — resolveEtablissement
  // alone still enforces the établissement exists, isn't archived, and its subscription is active.
  app.use('/api/public-order', resolveEtablissement, publicOrderRouter);

  if (hasFrontendBuild) {
    // Any other GET is a client-side route (Angular Router) — let the SPA shell handle it.
    app.get(/^\/(?!api\/|uploads\/).*/, (_req, res) => {
      res.sendFile(FRONTEND_INDEX);
    });
  }

  app.use((req, res) => {
    res.status(404).json({ error: `Route introuvable: ${req.method} ${req.path}` });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    console.error(err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  });

  return app;
}
