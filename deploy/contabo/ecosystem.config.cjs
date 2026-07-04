/**
 * PM2 ecosystem for Contabo osmani-admin-api.
 * Env is loaded from server/.env + repo .env via loadPm2Env.cjs (not shell-dependent).
 */
const path = require('node:path')
const { loadContaboPm2Env } = require('./loadPm2Env.cjs')

const ROOT = process.env.OSMANI_ADMIN_ROOT || '/var/www/osmani-admin-api'
const API_DIR = path.join(ROOT, 'server')
const fileEnv = loadContaboPm2Env(ROOT)

const SECRET_ENV_KEYS = [
  'DATABASE_URL',
  'ADMIN_API_TOKEN',
  'APP_UPDATE_ADMIN_TOKEN',
  'ADMIN_JWT_SECRET',
  'ADMIN_PANEL_AUTH_REQUIRED',
  'DIRECT_STREAM_SIGNING_SECRET',
  'ZENO_API_KEY',
  'SONICPESA_API_KEY',
  'AURAXPAY_API_KEY',
  'RESEND_API_KEY',
  'BUNNY_CDN_BASE_URL',
  'BASE_URL',
  'STREAM_API_BASE_URL',
  'UPLOAD_DIR',
]

const pm2Env = {
  NODE_ENV: 'production',
  PORT: '10001',
  OSMANI_ADMIN_ROOT: ROOT,
  OSMANI_LOAD_CUTOVER_ENV: '1',
  ...fileEnv,
}

const VPS_POOL_DEFAULTS = {
  OSMANI_VPS: '1',
  PG_POOL_MAX: '30',
  PG_POOL_CONNECT_TIMEOUT_MS: '5000',
  PG_QUERY_TIMEOUT_MS: '8000',
  APP_SETTINGS_CACHE_MS: '30000',
  GLOBAL_MODES_CACHE_MS: '15000',
  SUBSCRIPTION_ACCESS_CACHE_MS: '5000',
  SUBSCRIPTION_ACCESS_CACHE_ACTIVE_MS: '30000',
  VERIFY_PLANS_CACHE_MS: '60000',
  VERIFY_DB_MAX_CONCURRENT: '25',
  VERIFY_DB_SLOT_WAIT_MS: '30000',
  BENCHMARK_SAMPLE_DEVICE: '0',
  BENCHMARK_SAMPLE_DEVICE_LIMIT: '200',
  MODE_SSE_POLL_MS: '1200',
  PG_POOL_STATS: '1',
}
for (const [key, val] of Object.entries(VPS_POOL_DEFAULTS)) {
  if (!String(pm2Env[key] ?? '').trim()) pm2Env[key] = val
}

for (const key of SECRET_ENV_KEYS) {
  const val = String(fileEnv[key] ?? '').trim()
  if (val) pm2Env[key] = val
}

if (!String(pm2Env.DATABASE_URL || '').trim()) {
  console.error(
    '[ecosystem] DATABASE_URL missing — add to',
    path.join(API_DIR, '.env'),
    'or',
    path.join(ROOT, '.env'),
  )
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
      env: pm2Env,
      max_memory_restart: '512M',
      merge_logs: true,
      time: true,
      autorestart: true,
      max_restarts: 15,
      min_uptime: '5s',
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    },
  ],
}
