import 'dotenv/config';

export const config = {
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
};
