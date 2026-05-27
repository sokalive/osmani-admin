/**
 * One-shot: set Play Store production app-update fields in Postgres.
 * Requires DATABASE_URL (same DB as production API).
 *
 *   cd server && node scripts/set-app-update-playstore-v17.mjs
 */
import pg from 'pg'

const { Pool } = pg

const rows = [
  ['update_version_code', '17'],
  ['update_version_name', '1.7.0'],
  ['update_package_name', 'com.burudanitv.app'],
  ['update_source', 'play'],
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
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  for (const [key, value] of rows) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, value],
    )
    console.log(`set ${key} => ${value}`)
  }
  const check = await pool.query(
    `SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`,
    [rows.map((r) => r[0])],
  )
  console.log('stored:', Object.fromEntries(check.rows.map((r) => [r.key, r.value])))
} finally {
  await pool.end()
}
