import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

/** backend/.env — found from this file (src/ with tsx, dist/ once built), not from the folder the server
 * was started in: started from elsewhere (e.g. `pm2 start backend/dist/server.js` from the repo root), a
 * cwd-relative .env would silently be missed (no SMTP, default keys…). */
export const ENV_FILE = path.resolve(__dirname, '..', '.env');
const envLoaded = fs.existsSync(ENV_FILE) && !dotenv.config({ path: ENV_FILE }).error;
if (!envLoaded) console.warn(`Fichier de configuration introuvable : ${ENV_FILE} — valeurs par défaut utilisées.`);

export const config = {
  /** Where Kaly Manager is served (the site root leads to the subscription page, /tokens/). */
  kalyAppPath: '/km',
  /** Whether backend/.env was found and read at startup (shown in /ap). */
  envFile: { path: ENV_FILE, loaded: envLoaded },
  port: Number(process.env.PORT ?? 3001),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  // corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',
    corsOrigin: '*',
  platformAdminKey: process.env.PLATFORM_ADMIN_KEY ?? 'admin123',
  /** Outgoing e-mail. Left unset (no SMTP_HOST), the app simply sends nothing. */
  smtp: {
    host: process.env.SMTP_HOST?.trim() || undefined,
    port: Number(process.env.SMTP_PORT ?? 587),
    /** true for port 465 (implicit TLS); false for 587/25 (STARTTLS negotiated automatically). */
    secure: process.env.SMTP_SECURE === 'true',
    user: process.env.SMTP_USER?.trim() || undefined,
    pass: process.env.SMTP_PASS || undefined,
    from: process.env.SMTP_FROM?.trim() || undefined,
  },
  /** Who receives the platform notifications (new contact message / token request). Comma-separated. */
  notifyEmail: process.env.NOTIFY_EMAIL?.trim() || undefined,
  /** Online (card) payment on the subscription screens. Off = on standby: the screens send a token request
   * by e-mail instead, and the purchase routes refuse. Set ONLINE_PAYMENT_ENABLED=true to bring it back. */
  onlinePayment: process.env.ONLINE_PAYMENT_ENABLED === 'true',
};
