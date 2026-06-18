/**
 * PM2 ecosystem for Contabo osmani-admin-api.
 * Node starts src/index.js directly; loadEnv.js loads .env + .env.cutover on import.
 */
const ROOT = process.env.OSMANI_ADMIN_ROOT || '/var/www/osmani-admin-api'
const API_DIR = `${ROOT}/server`

module.exports = {
  apps: [
    {
      name: 'osmani-admin-api',
      cwd: API_DIR,
      script: 'src/index.js',
      interpreter: 'node',
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
      autorestart: true,
      max_restarts: 15,
      min_uptime: '5s',
    },
  ],
}
