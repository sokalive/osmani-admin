/**
 * PM2 ecosystem for Contabo osmani-admin-api.
 * Secrets (DATABASE_URL) must be in process.env when pm2 start runs —
 * apply-cutover.sh sources server/.env before invoking this file.
 */
const ROOT = process.env.OSMANI_ADMIN_ROOT || '/var/www/osmani-admin-api'
const API_DIR = `${ROOT}/server`

const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'ADMIN_API_TOKEN',
  'APP_UPDATE_ADMIN_TOKEN',
  'ADMIN_JWT_SECRET',
  'DIRECT_STREAM_SIGNING_SECRET',
  'ZENO_API_KEY',
  'SONICPESA_API_KEY',
  'AURAXPAY_API_KEY',
  'RESEND_API_KEY',
]

function pickProcessEnv(keys) {
  const out = {}
  for (const key of keys) {
    const val = String(process.env[key] ?? '').trim()
    if (val) out[key] = val
  }
  return out
}

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
        OSMANI_LOAD_CUTOVER_ENV: '1',
        OSMANI_GIT_COMMIT: process.env.OSMANI_GIT_COMMIT || '',
        ...pickProcessEnv(SECRET_ENV_KEYS),
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
