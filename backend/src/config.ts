import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT ?? 3001),
  jwtSecret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
  // corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:4200',
    corsOrigin: '*',
  platformAdminKey: process.env.PLATFORM_ADMIN_KEY ?? 'admin123',
};
