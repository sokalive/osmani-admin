#!/usr/bin/env node
/**
 * Backfill transactions.phone from raw_payload when column is empty (report + optional apply).
 *
 *   node server/scripts/backfill-transaction-phone-from-payload.mjs
 *   APPLY=1 node server/scripts/backfill-transaction-phone-from-payload.mjs
 */
import pg from 'pg'
import { phoneFromTransactionRow, normalizePhoneDigits } from '../src/billingStore.js'

const { Pool } = pg
const url = process.env.DATABASE_URL
const apply = String(process.env.APPLY || '0').trim() === '1'
if (!url) {
  console.error('DATABASE_URL required')
  process.exit(2)
}

const pool = new Pool({ connectionString: url })

async function main() {
  const { rows } = await pool.query(
    `SELECT order_id, device_id, phone, raw_payload, status, created_at
     FROM transactions
     WHERE plan_id IS NOT NULL
       AND trim(coalesce(phone::text, '')) = ''
     ORDER BY created_at DESC
     LIMIT 500`,
  )
  const candidates = []
  for (const r of rows) {
    const inferred = phoneFromTransactionRow(r)
    const digits = normalizePhoneDigits(inferred)
    if (!digits || digits.length < 10) continue
    const phone = /^255\d{9}$/.test(digits) ? `+${digits}` : inferred
    candidates.push({
      order_id: r.order_id,
      device_id: r.device_id,
      phone,
      status: r.status,
      created_at: r.created_at,
    })
  }
  console.log('Empty-phone transactions scanned:', rows.length)
  console.log('Backfill candidates:', candidates.length)
  for (const c of candidates.slice(0, 20)) {
    console.log(JSON.stringify(c))
  }
  if (!apply) {
    console.log('\nDry run only. Set APPLY=1 to update rows.')
    await pool.end()
    return
  }
  let updated = 0
  for (const c of candidates) {
    const res = await pool.query(
      `UPDATE transactions SET phone = $2, updated_at = now()
       WHERE order_id = $1 AND trim(coalesce(phone::text, '')) = ''`,
      [c.order_id, c.phone],
    )
    updated += Number(res.rowCount) || 0
    if (c.device_id) {
      await pool.query(
        `INSERT INTO device_phone_registry (device_id, install_instance_id, phone_number_raw, phone_number_normalized, created_at, updated_at)
         VALUES ($1, '', $2, $3, now(), now())
         ON CONFLICT (device_id, install_instance_id) DO NOTHING`,
        [String(c.device_id), c.phone, normalizePhoneDigits(c.phone)],
      ).catch(() => {})
    }
  }
  console.log('Updated transactions.phone:', updated)
  await pool.end()
}

main().catch(async (e) => {
  console.error(e)
  await pool.end().catch(() => {})
  process.exit(1)
})
