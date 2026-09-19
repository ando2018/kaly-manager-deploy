module.exports = {
  apps: [
    {
      name: 'kaly-manager-backend',
      script: 'dist/server.js',
      cwd: __dirname,
      // .env (PORT, JWT_SECRET, PLATFORM_ADMIN_KEY, CORS_ORIGIN) is loaded by config.ts via dotenv —
      // no need to duplicate those values here.
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      time: true,
    },
  ],
};
