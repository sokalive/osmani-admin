/**
 * PM2 ecosystem for Contabo osmani-admin-api.
 * Usage (on VPS):
 *   cd /var/www/osmani-admin/server
 *   cp ../deploy/contabo/env.production.example .env   # edit secrets first
 *   pm2 start ../deploy/contabo/ecosystem.config.cjs
 *   pm2 save
 */
module.exports = {
  apps: [
    {
      name: 'osmani-admin-api',
      cwd: '/var/www/osmani-admin/server',
      script: 'src/index.js',
      interpreter: 'node',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 10001,
      },
      env_file: '/var/www/osmani-admin/server/.env',
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
    },
  ],
}
