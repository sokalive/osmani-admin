/**
 * Safe backfill: copy fingerprint_hash from device_trial_entitlements → device_subscriptions
 * for the same device_id (no deletes). Improves APK migration recover for existing paid users.
 *
 *   cd server && node scripts/backfill-subscription-fingerprints.mjs
 */
import pg from 'pg'

const { Pool } = pg
const url = String(process.env.DATABASE_URL || '').trim()
if (!url) {
  console.error('DATABASE_URL required')
  process.exit(1)
}

const pool = new Pool({
  connectionString: url,
  ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
})

const { rowCount } = await pool.query(
  `UPDATE device_subscriptions ds
   SET fingerprint_hash = dte.fingerprint_hash, updated_at = now()
   FROM device_trial_entitlements dte
   WHERE ds.device_id = dte.device_id
     AND ds.status = 'active'
     AND ds.expires_at > now()
     AND (ds.fingerprint_hash IS NULL OR ds.fingerprint_hash = '')
     AND dte.fingerprint_hash IS NOT NULL
     AND dte.fingerprint_hash <> ''`,
)
console.log(`OK backfilled fingerprint_hash on ${rowCount} active subscription row(s)`)
await pool.end()
