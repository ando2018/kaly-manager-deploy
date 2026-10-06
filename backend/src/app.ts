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
import { tokensRouter } from './routes/tokens.routes';
import { settingsRouter } from './routes/settings.routes';
import { supportRouter } from './routes/support.routes';
import { eventsRouter } from './routes/events.routes';
import { publicOrderRouter } from './routes/public-order.routes';
import {
  IMAGE_LIBRARY_DISK_PATH,
  IMAGE_LIBRARY_PUBLIC_PATH,
  UPLOADS_DISK_PATH,
  UPLOADS_PUBLIC_PATH,
} from './middleware/upload.middleware';
import { resolveEtablissement } from './middleware/etablissement.middleware';

// Built Angular app (`npm run build` in frontend/) — served here so the whole app runs on one port.
const FRONTEND_DIST = path.resolve(__dirname, '..', '..', 'frontend', 'dist', 'kaly-manager', 'browser');
const FRONTEND_INDEX = path.join(FRONTEND_DIST, 'index.html');
const hasFrontendBuild = fs.existsSync(FRONTEND_INDEX);
// The token-manager app (../token-manager), built with base href /tokens/.
const TOKEN_MANAGER_DIST = path.resolve(__dirname, '..', '..', 'token-manager', 'dist', 'token-manager', 'browser');
const TOKEN_MANAGER_INDEX = path.join(TOKEN_MANAGER_DIST, 'index.html');
const hasTokenManagerBuild = fs.existsSync(TOKEN_MANAGER_INDEX);
const SAFETY_WORKER = path.join(FRONTEND_DIST, 'safety-worker.js');
const KALY_PATH = config.kalyAppPath;

/** The site root: to the subscription page — or to Kaly Manager when opened as the installed app. */
const ROOT_PAGE = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kaly Manager</title>
<script>
  var installed = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  location.replace(installed ? '${KALY_PATH}/' : '/tokens/');
</script>
</head>
<body style="background:#0f172a;color:#f1f5f9;font-family:system-ui,sans-serif;text-align:center;padding:3rem 1rem">
<p><a style="color:#10b981" href="/tokens/">Abonnements</a> · <a style="color:#10b981" href="${KALY_PATH}/">Kaly Manager</a></p>
</body>
</html>`;


export function createApp() {
  const app = express();

  app.use(cors({ origin: config.corsOrigin, credentials: true }));
  app.use(express.json());
  app.use(UPLOADS_PUBLIC_PATH, express.static(UPLOADS_DISK_PATH));
  app.use(IMAGE_LIBRARY_PUBLIC_PATH, express.static(IMAGE_LIBRARY_DISK_PATH));
  // The site root: the subscription page — except for Kaly Manager installed on a home screen (its old
  // start URL is /), which keeps opening Kaly Manager.
  app.get('/', (_req, res) => {
    res.type('html').send(ROOT_PAGE);
  });

  if (hasFrontendBuild) {
    app.use(KALY_PATH, express.static(FRONTEND_DIST));
    // Kaly Manager's service worker used to live at the root: browsers that still have it get Angular's
    // « safety worker », which unregisters itself and clears its caches (otherwise the old cached app
    // would keep answering every page of the site, /tokens/ included).
    app.get('/ngsw-worker.js', (_req, res) => {
      res.set('Cache-Control', 'no-cache');
      if (fs.existsSync(SAFETY_WORKER)) res.sendFile(SAFETY_WORKER);
      else res.status(404).end();
    });
    app.get('/ngsw.json', (_req, res) => res.status(404).end());
  }

  app.get('/api/health', (_req, res) => res.json({ status: 'ok' }));

  // Platform-level: creating/listing etablissements, or checking an id exists. Not scoped to an établissement.
  app.use('/api/platform', platformRouter);
  // Tokens of every application on this backend — managed from the token-manager app.
  app.use('/api/tokens', tokensRouter);
  if (hasTokenManagerBuild) {
    app.use('/tokens', express.static(TOKEN_MANAGER_DIST));
    app.get(/^\/tokens(\/.*)?$/, (_req, res) => res.sendFile(TOKEN_MANAGER_INDEX));
  } else {
    // Not built on this server: say so, instead of falling through to the Kaly Manager app.
    console.warn(`Gestion des tokens non compilée (${TOKEN_MANAGER_INDEX} introuvable) : /tokens indisponible.`);
    app.get(/^\/tokens(\/.*)?$/, (_req, res) => {
      res
        .status(503)
        .type('text/plain; charset=utf-8')
        .send(
          'Gestion des tokens non compilée sur ce serveur.\n\n' +
            'Sur le serveur : npm install --prefix token-manager && npm run build --prefix token-manager,\n' +
            'puis redémarrez le backend (pm2 reload kaly-manager).',
        );
    });
  }

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
    // Any other GET under /km is a client-side route (Angular Router) — let the SPA shell handle it.
    app.get(/^\/km(\/.*)?$/, (_req, res) => {
      res.sendFile(FRONTEND_INDEX);
    });
    // Kaly Manager's addresses from before /km (table QR codes already printed, links in e-mails,
    // bookmarks): /etablissement/…, /commande-table/… → /km/etablissement/…, /km/commande-table/…
    app.get(/^\/(?!api\/|uploads\/|image-library\/|tokens(\/|$)|km(\/|$)|socket\.io\/).+/, (req, res) => {
      res.redirect(302, `${KALY_PATH}${req.originalUrl}`);
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
