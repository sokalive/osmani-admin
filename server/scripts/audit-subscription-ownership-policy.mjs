#!/usr/bin/env node
/**
 * Read-only production audit for subscription ownership policy metrics.
 * Redacts phone numbers and device IDs in output.
 * Run: DATABASE_URL=... node server/scripts/audit-subscription-ownership-policy.mjs
 */
import crypto from 'node:crypto'

function redactId(s, n = 8) {
  const x = String(s ?? '')
  if (!x) return null
  const h = crypto.createHash('sha256').update(x).digest('hex').slice(0, 10)
  return `${x.slice(0, Math.min(4, x.length))}…${h}`
}

function redactPhone(p) {
  const d = String(p ?? '').replace(/\D/g, '')
  if (d.length < 6) return '***'
  return `${d.slice(0, 3)}***${d.slice(-3)}`
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required')
    process.exit(1)
  }
  const { getPool } = await import('../src/db/pool.js')
  const { ensureBillingStorage } = await import('../src/billingStore.js')
  await ensureBillingStorage()
  const pool = getPool()

  const { rows: movedRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_subscriptions WHERE transaction_id::text LIKE 'moved:%'`,
  )
  const { rows: recoveryRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_subscriptions WHERE transaction_id::text LIKE 'recovery:%'`,
  )
  const { rows: phoneConflictRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM transactions
     WHERE coalesce(raw_payload->>'phone_conflict', '') = 'true'
        OR coalesce(raw_payload->'activation_result'->>'activation_state', '') = 'PHONE_CONFLICT'`,
  )
  const { rows: siblingMovedRows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM transactions
     WHERE coalesce(raw_payload->'activation_result'->>'activation_state', '') = 'MOVED_TO_SIBLING_DEVICE'`,
  )
  const { rows: completedNoEntitlement } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM transactions t
     WHERE t.status = 'completed'
       AND trim(coalesce(t.device_id::text, '')) <> ''
       AND NOT EXISTS (
         SELECT 1 FROM device_subscriptions ds
         WHERE ds.device_id = t.device_id
           AND ds.transaction_id = t.order_id
           AND ds.status = 'active'
           AND ds.expires_at > now()
       )
       AND coalesce(t.raw_payload->'activation_result'->>'activation_state', '') NOT IN ('PHONE_CONFLICT', 'MOVED_TO_SIBLING_DEVICE')
       AND t.order_id NOT LIKE 'manual_grant:%'
       AND t.created_at > now() - interval '90 days'`,
  )
  const { rows: samePhoneMultiDevice } = await pool.query(
    `WITH phone_devices AS (
       SELECT ${/* tz canonical */''}
         regexp_replace(regexp_replace(trim(coalesce(t.phone, '')), '^\\+', ''), '^0', '255') AS phone_norm,
         trim(t.device_id::text) AS device_id
       FROM transactions t
       WHERE t.status = 'completed'
         AND trim(coalesce(t.phone, '')) <> ''
         AND trim(coalesce(t.device_id::text, '')) <> ''
     ),
     active_by_phone AS (
       SELECT pd.phone_norm, COUNT(DISTINCT ds.device_id)::int AS active_device_count
       FROM phone_devices pd
       INNER JOIN device_subscriptions ds ON ds.device_id = pd.device_id
       WHERE ds.status = 'active' AND ds.expires_at > now()
         AND COALESCE(ds.manual_admin_blocked, false) = false
       GROUP BY pd.phone_norm
       HAVING COUNT(DISTINCT ds.device_id) > 1
     )
     SELECT COUNT(*)::int AS phone_count, COALESCE(SUM(active_device_count), 0)::int AS total_devices
     FROM active_by_phone`,
  )
  const { rows: separateOrdersSamePhone } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM (
       SELECT regexp_replace(regexp_replace(trim(coalesce(phone, '')), '^\\+', ''), '^0', '255') AS phone_norm,
              COUNT(DISTINCT device_id)::int AS devices,
              COUNT(*)::int AS orders
       FROM transactions
       WHERE status = 'completed' AND trim(coalesce(phone, '')) <> ''
       GROUP BY 1
       HAVING COUNT(DISTINCT device_id) > 1 AND COUNT(*) > 1
     ) x`,
  )

  const sampleConflicts = await pool.query(
    `SELECT order_id, device_id, phone, status, created_at,
            raw_payload->'activation_result'->>'activation_state' AS activation_state
     FROM transactions
     WHERE coalesce(raw_payload->>'phone_conflict', '') = 'true'
        OR coalesce(raw_payload->'activation_result'->>'activation_state', '') = 'PHONE_CONFLICT'
     ORDER BY created_at DESC
     LIMIT 5`,
  )

  const report = {
    audited_at: new Date().toISOString(),
    policy: 'payment_bound_to_originating_device',
    moved_transaction_id_count: movedRows[0]?.n ?? 0,
    recovery_transaction_id_count: recoveryRows[0]?.n ?? 0,
    phone_conflict_count: phoneConflictRows[0]?.n ?? 0,
    moved_to_sibling_activation_count: siblingMovedRows[0]?.n ?? 0,
    completed_without_entitlement_90d: completedNoEntitlement[0]?.n ?? 0,
    same_phone_multi_active_device_phones: samePhoneMultiDevice[0]?.phone_count ?? 0,
    same_phone_multi_active_device_total: samePhoneMultiDevice[0]?.total_devices ?? 0,
    separate_successful_orders_same_phone_multi_device: separateOrdersSamePhone[0]?.n ?? 0,
    sample_phone_conflicts_redacted: sampleConflicts.rows.map((r) => ({
      order_id: redactId(r.order_id),
      device_id: redactId(r.device_id),
      phone: redactPhone(r.phone),
      status: r.status,
      activation_state: r.activation_state,
      created_at: r.created_at,
    })),
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
