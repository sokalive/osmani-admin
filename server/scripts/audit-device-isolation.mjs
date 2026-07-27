/**
 * Production-safe device isolation audit (read-only).
 *
 * Verifies active entitlements / transactions cannot cross-contaminate by phone.
 * NEVER changes expires_at, ownership, or status.
 *
 * Usage (VPS with DATABASE_URL):
 *   node scripts/audit-device-isolation.mjs
 */
import { getPool, closePool } from '../src/db/pool.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

async function main() {
  const pool = requirePool()
  const report = {
    ok: true,
    at: new Date().toISOString(),
    findings: {},
    samples: {},
  }

  const { rows: sharedTxn } = await pool.query(
    `SELECT transaction_id, COUNT(*)::int AS n, array_agg(device_id::text ORDER BY device_id) AS devices
     FROM device_subscriptions
     WHERE status = 'active'
       AND expires_at > now()
       AND transaction_id IS NOT NULL
       AND trim(transaction_id::text) <> ''
     GROUP BY transaction_id
     HAVING COUNT(*) > 1
     LIMIT 50`,
  )
  report.findings.shared_active_transaction_id = sharedTxn.length
  report.samples.shared_active_transaction_id = sharedTxn.slice(0, 10).map((r) => ({
    transaction_id: String(r.transaction_id).slice(0, 28),
    n: Number(r.n),
    device_count: Array.isArray(r.devices) ? r.devices.length : 0,
  }))

  // Multi-active devices sharing a normalized payment phone (allowed policy — must not guess owner).
  const { rows: multiActivePhone } = await pool.query(
    `WITH phone_links AS (
       SELECT
         CASE
           WHEN length(regexp_replace(coalesce(t.phone::text, ''), '\\D', '', 'g')) = 10
             AND regexp_replace(coalesce(t.phone::text, ''), '\\D', '', 'g') LIKE '0%'
           THEN '255' || substr(regexp_replace(coalesce(t.phone::text, ''), '\\D', '', 'g'), 2)
           WHEN length(regexp_replace(coalesce(t.phone::text, ''), '\\D', '', 'g')) = 9
           THEN '255' || regexp_replace(coalesce(t.phone::text, ''), '\\D', '', 'g')
           ELSE regexp_replace(coalesce(t.phone::text, ''), '\\D', '', 'g')
         END AS phone_digits,
         trim(t.device_id::text) AS device_id
       FROM transactions t
       WHERE t.status = 'completed'
         AND trim(coalesce(t.device_id::text, '')) <> ''
         AND trim(coalesce(t.phone::text, '')) <> ''
       UNION
       SELECT dpr.phone_number_normalized, trim(dpr.device_id::text)
       FROM device_phone_registry dpr
       WHERE trim(coalesce(dpr.phone_number_normalized, '')) <> ''
         AND trim(coalesce(dpr.device_id::text, '')) <> ''
     ),
     active_by_phone AS (
       SELECT pl.phone_digits, ds.device_id::text AS device_id
       FROM phone_links pl
       JOIN device_subscriptions ds ON ds.device_id = pl.device_id
       WHERE ds.status = 'active'
         AND ds.expires_at > now()
         AND length(pl.phone_digits) >= 10
     )
     SELECT phone_digits, COUNT(DISTINCT device_id)::int AS active_devices
     FROM active_by_phone
     GROUP BY phone_digits
     HAVING COUNT(DISTINCT device_id) > 1
     ORDER BY active_devices DESC
     LIMIT 100`,
  )
  report.findings.multi_active_same_phone_clusters = multiActivePhone.length
  report.findings.multi_active_same_phone_devices_total = multiActivePhone.reduce(
    (s, r) => s + Number(r.active_devices || 0),
    0,
  )
  report.samples.multi_active_same_phone = multiActivePhone.slice(0, 15).map((r) => ({
    phone_redacted: `${String(r.phone_digits).slice(0, 3)}***${String(r.phone_digits).slice(-3)}`,
    active_devices: Number(r.active_devices),
  }))
  report.findings.note_multi_active =
    'Independent devices may share a phone. Owner resolution must refuse ambiguity (AMBIGUOUS_PHONE_OWNERSHIP).'

  const { rows: txnMismatch } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions ds
     JOIN transactions t ON t.order_id = ds.transaction_id AND t.status = 'completed'
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND trim(coalesce(t.device_id::text, '')) <> ''
       AND t.device_id IS DISTINCT FROM ds.device_id
       AND ds.transaction_id NOT LIKE 'manual_grant:%'
       AND ds.transaction_id NOT LIKE 'moved:%'
       AND ds.transaction_id NOT LIKE 'transfer:%'
       AND ds.transaction_id NOT LIKE 'force:%'
       AND ds.transaction_id NOT LIKE 'recovery:%'
       -- Hamisha / admin force leave the payment txn on the payer device while
       -- entitlement lives on the target. That is ownership history, not contamination.
       AND NOT EXISTS (
         SELECT 1 FROM device_transfers dt
         WHERE dt.status = 'completed'
           AND (
             (dt.target_device_id = ds.device_id AND dt.source_device_id = t.device_id)
             OR (dt.target_device_id = ds.device_id AND dt.source_device_id IS NOT NULL)
           )
       )`,
  )
  report.findings.active_paid_txn_device_mismatch_unexplained = Number(txnMismatch[0]?.n) || 0

  const { rows: txnMismatchAll } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions ds
     JOIN transactions t ON t.order_id = ds.transaction_id AND t.status = 'completed'
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND trim(coalesce(t.device_id::text, '')) <> ''
       AND t.device_id IS DISTINCT FROM ds.device_id
       AND ds.transaction_id NOT LIKE 'manual_grant:%'
       AND ds.transaction_id NOT LIKE 'moved:%'
       AND ds.transaction_id NOT LIKE 'transfer:%'
       AND ds.transaction_id NOT LIKE 'force:%'
       AND ds.transaction_id NOT LIKE 'recovery:%'`,
  )
  report.findings.active_paid_txn_device_mismatch_including_transfers = Number(txnMismatchAll[0]?.n) || 0
  report.findings.note_txn_device_mismatch =
    'Payer device_id on a completed txn may differ from current entitlement device after Hamisha; verify still keys by device_subscriptions.device_id.'

  const { rows: grantMismatch } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions ds
     JOIN manual_subscription_grants g
       ON g.deleted_at IS NULL
      AND ds.transaction_id = ('manual_grant:' || g.id::text)
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND g.device_id IS DISTINCT FROM ds.device_id`,
  )
  report.findings.active_grant_device_mismatch = Number(grantMismatch[0]?.n) || 0
  report.findings.note_grant_device_mismatch =
    'After Hamisha, entitlement may keep manual_grant:{id} while grants.device_id remains the original payer device. Verify ownership is device_subscriptions.device_id.'

  const { rows: preserveOwned } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions ds
     JOIN transactions t ON t.order_id = ds.transaction_id AND t.status = 'completed'
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND (
         t.raw_payload->'activation_result'->>'expiry_policy' = 'preserve_existing_active'
         OR t.raw_payload->'activation_result'->>'reason' = 'preserve_existing_active'
       )`,
  )
  report.findings.linked_txn_still_marked_preserve_existing = Number(preserveOwned[0]?.n) || 0

  const failures = []
  if (report.findings.shared_active_transaction_id > 0) {
    failures.push('shared_active_transaction_id')
  }
  // Grant row device may differ from current entitlement holder after Hamisha (preserved txn id).
  report.findings.active_grant_device_mismatch_informational =
    report.findings.active_grant_device_mismatch
  // txn payer≠holder is reported but not a deploy failure (Hamisha / legacy force paths).
  report.findings.unexplained_txn_mismatch_informational =
    report.findings.active_paid_txn_device_mismatch_unexplained

  report.ok = failures.length === 0
  report.failures = failures
  console.log(JSON.stringify(report, null, 2))
  await closePool().catch(() => {})
  if (!report.ok) process.exit(2)
}

main().catch(async (e) => {
  console.error('[audit-device-isolation] failed:', e)
  await closePool().catch(() => {})
  process.exit(1)
})
