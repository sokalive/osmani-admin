/**
 * PM2 ecosystem for Contabo osmani-admin-api.
 * Uses start-with-env.sh so server/.env + .env.cutover are always loaded.
 */
const ROOT = process.env.OSMANI_ADMIN_ROOT || '/var/www/osmani-admin-api'
const API_DIR = `${ROOT}/server`

module.exports = {
  apps: [
    {
      name: 'osmani-admin-api',
      cwd: API_DIR,
      script: 'scripts/start-with-env.sh',
      interpreter: 'bash',
      instances: 1,
      exec_mode: 'fork',
      env: {
        NODE_ENV: 'production',
        PORT: 10001,
        OSMANI_ADMIN_ROOT: ROOT,
      },
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
    },
  ],
}
