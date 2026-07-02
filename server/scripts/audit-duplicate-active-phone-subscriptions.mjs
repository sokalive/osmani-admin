#!/usr/bin/env node
/**
 * Production audit: duplicate active subscriptions per payment phone.
 * Report-only — does not modify data.
 *
 *   node server/scripts/audit-duplicate-active-phone-subscriptions.mjs
 *   DATABASE_URL=postgres://... node server/scripts/audit-duplicate-active-phone-subscriptions.mjs
 */
import pg from 'pg'
import { tzPhoneCanonicalSql } from '../src/billingStore.js'

const { Pool } = pg
const url = process.env.DATABASE_URL
if (!url) {
  console.error('DATABASE_URL required')
  process.exit(2)
}

const pool = new Pool({ connectionString: url })

const phoneDevicesCte = `
  phone_devices AS (
    SELECT DISTINCT
      ${tzPhoneCanonicalSql('t.phone::text')} AS phone_digits,
      trim(t.device_id::text) AS device_id
    FROM transactions t
    WHERE t.status = 'completed'
      AND trim(coalesce(t.device_id::text, '')) <> ''
      AND trim(coalesce(t.phone::text, '')) <> ''
    UNION
    SELECT DISTINCT
      trim(dpr.phone_number_normalized::text) AS phone_digits,
      trim(dpr.device_id::text) AS device_id
    FROM device_phone_registry dpr
    WHERE trim(coalesce(dpr.device_id::text, '')) <> ''
      AND trim(coalesce(dpr.phone_number_normalized::text, '')) <> ''
  )`

async function main() {
  console.log('=== Duplicate active phone subscription audit ===')
  console.log('Time:', new Date().toISOString())

  const { rows: clusters } = await pool.query(
    `WITH ${phoneDevicesCte},
     active_subs AS (
       SELECT
         pd.phone_digits,
         ds.device_id::text AS device_id,
         ds.expires_at,
         ds.status,
         ds.transaction_id,
         ds.started_at
       FROM device_subscriptions ds
       INNER JOIN phone_devices pd ON pd.device_id = ds.device_id::text
       WHERE ds.expires_at > now()
         AND LOWER(COALESCE(NULLIF(trim(ds.status::text), ''), 'active')) = 'active'
         AND COALESCE(ds.manual_admin_blocked, false) = false
         AND COALESCE(ds.transaction_id::text, '') NOT LIKE 'moved:%'
         AND NOT EXISTS (
           SELECT 1 FROM device_transfers dt
           WHERE dt.status = 'completed'
             AND dt.source_device_id::text = ds.device_id::text
         )
         AND length(pd.phone_digits) >= 10
     )
     SELECT
       phone_digits,
       count(DISTINCT device_id)::int AS active_device_count,
       array_agg(DISTINCT device_id ORDER BY device_id) AS device_ids,
       min(expires_at) AS earliest_expiry,
       max(expires_at) AS latest_expiry
     FROM active_subs
     GROUP BY phone_digits
     HAVING count(DISTINCT device_id) > 1
     ORDER BY count(DISTINCT device_id) DESC, phone_digits
     LIMIT 200`,
  )

  const { rows: countRow } = await pool.query(
    `WITH ${phoneDevicesCte},
     active_subs AS (
       SELECT pd.phone_digits, ds.device_id::text AS device_id
       FROM device_subscriptions ds
       INNER JOIN phone_devices pd ON pd.device_id = ds.device_id::text
       WHERE ds.expires_at > now()
         AND LOWER(COALESCE(NULLIF(trim(ds.status::text), ''), 'active')) = 'active'
         AND COALESCE(ds.manual_admin_blocked, false) = false
         AND COALESCE(ds.transaction_id::text, '') NOT LIKE 'moved:%'
         AND NOT EXISTS (
           SELECT 1 FROM device_transfers dt
           WHERE dt.status = 'completed'
             AND dt.source_device_id::text = ds.device_id::text
         )
         AND length(pd.phone_digits) >= 10
     )
     SELECT count(DISTINCT phone_digits)::int AS phones_with_active_sub
     FROM active_subs`,
  )

  const duplicatePhones = clusters.length
  const phonesWithActive = Number(countRow[0]?.phones_with_active_sub) || 0

  console.log('\n--- Summary ---')
  console.log('Phones with any active subscription:', phonesWithActive)
  console.log('Phones with DUPLICATE active devices:', duplicatePhones)

  if (duplicatePhones > 0) {
    console.log('\n--- Duplicate clusters (invalid — pre-guard legacy data) ---')
    for (const c of clusters) {
      console.log(
        JSON.stringify({
          phone: c.phone_digits,
          active_device_count: c.active_device_count,
          device_ids: c.device_ids,
          earliest_expiry: c.earliest_expiry,
          latest_expiry: c.latest_expiry,
        }),
      )
    }
    console.log('\nRESULT: FAIL — duplicate active phone clusters found (report only, no auto-repair)')
    process.exit(1)
  }

  console.log('\nRESULT: PASS — 0 duplicate active phone clusters')
  await pool.end()
  process.exit(0)
}

main().catch(async (e) => {
  console.error(e)
  await pool.end().catch(() => {})
  process.exit(2)
})
