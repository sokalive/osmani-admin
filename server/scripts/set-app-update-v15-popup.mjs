/**
 * Enable soft update prompts for Play Store v15 cohort only (server gates v16+).
 * Does not change published target version_code (keeps v24 Play listing metadata).
 *
 *   cd server && node scripts/set-app-update-v15-popup.mjs
 */
import pg from 'pg'

const { Pool } = pg

const rows = [
  ['update_soft', 'true'],
  ['update_force', 'false'],
]

const url = String(process.env.DATABASE_URL || '').trim()
if (!url) {
  console.error('DATABASE_URL is required')
  process.exit(1)
}

const pool = new Pool({
  connectionString: url,
  ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
})

try {
  for (const [key, value] of rows) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    )
    console.log(`set ${key} => ${value}`)
  }
  console.log('Only versionCode 15 clients receive SOFT (see lib/appUpdateTargeting.js).')
} finally {
  await pool.end()
}
