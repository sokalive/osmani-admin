/**
 * Audit + safe repair: Account boxes must match ONE entitlement-linked Plan.
 *
 * Detects preserve_existing_active overwrites where a newer payment's
 * plan_id/duration/price was attached to an older expires_at timeline
 * (e.g. Wiki 1 Duration=7 + Remaining=2 + Expiry from a shorter package).
 *
 * NEVER changes expires_at / remaining / status.
 * Only restores device_subscriptions.transaction_id to the entitlement owner.
 *
 * Usage (VPS with DATABASE_URL):
 *   node scripts/audit-account-plan-consistency.mjs
 *   node scripts/audit-account-plan-consistency.mjs --repair
 */
import { getPool, closePool } from '../src/db/pool.js'

const REPAIR = process.argv.includes('--repair')
const TZ = 'Africa/Dar_es_Salaam'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function spanDaysSql(startCol, endCol) {
  return `(
    (${endCol} AT TIME ZONE '${TZ}')::date
    - (${startCol} AT TIME ZONE '${TZ}')::date
  )`
}

async function findOwnerTransactionId(pool, deviceId, expiresAt, spanDays) {
  const d = String(deviceId)
  const span = Math.trunc(Number(spanDays))
  const exp = expiresAt

  // 1) Manual grant whose snapshot expiry matches the live entitlement.
  const { rows: grants } = await pool.query(
    `SELECT g.id, g.duration_days, g.expires_at_snapshot, g.created_at
     FROM manual_subscription_grants g
     WHERE g.device_id = $1
       AND g.deleted_at IS NULL
       AND g.expires_at_snapshot IS NOT NULL
       AND ABS(EXTRACT(EPOCH FROM (g.expires_at_snapshot - $2::timestamptz))) < 120
     ORDER BY
       CASE
         WHEN $3::int IS NOT NULL AND ABS(g.duration_days - $3::int) <= 1 THEN 0
         ELSE 1
       END,
       g.created_at DESC
     LIMIT 1`,
    [d, exp, Number.isFinite(span) ? span : null],
  )
  if (grants[0]?.id != null) return `manual_grant:${Number(grants[0].id)}`

  // 2) Completed payment whose purchased duration matches the entitlement calendar span.
  if (Number.isFinite(span) && span >= 1) {
    const { rows: txns } = await pool.query(
      `SELECT t.order_id, t.plan_id, COALESCE(t.plan_duration_days, p.duration_days) AS days
       FROM transactions t
       LEFT JOIN plans p ON p.id = t.plan_id
       WHERE t.device_id = $1
         AND t.status = 'completed'
         AND t.order_id NOT LIKE 'manual_grant:%'
         AND COALESCE(t.plan_duration_days, p.duration_days) IS NOT NULL
         AND ABS(COALESCE(t.plan_duration_days, p.duration_days) - $2::int) <= 1
       ORDER BY COALESCE(t.updated_at, t.created_at) DESC
       LIMIT 1`,
      [d, span],
    )
    if (txns[0]?.order_id) return String(txns[0].order_id)
  }

  return null
}

async function main() {
  const pool = requirePool()
  const report = {
    ok: true,
    repair: REPAIR,
    at: new Date().toISOString(),
    findings: {},
    samples: [],
    repaired: [],
    skipped: [],
  }

  const { rows: mismatches } = await pool.query(
    `SELECT
       ds.device_id,
       ds.transaction_id,
       ds.started_at,
       ds.expires_at,
       ${spanDaysSql('ds.started_at', 'ds.expires_at')}::int AS span_days,
       GREATEST(
         0,
         (
           (ds.expires_at AT TIME ZONE '${TZ}')::date
           - (now() AT TIME ZONE '${TZ}')::date
         )
       )::int AS remaining_days,
       COALESCE(t.plan_duration_days, p.duration_days, g.duration_days) AS plan_days,
       COALESCE(t.amount, p.price, gp.price) AS amount,
       COALESCE(p.name, gp.name) AS plan_name,
       t.plan_id AS pay_plan_id,
       g.plan_id AS grant_plan_id,
       COALESCE(
         t.raw_payload->'activation_result'->>'expiry_policy',
         t.raw_payload->'activation_result'->>'reason'
       ) AS activation_hint
     FROM device_subscriptions ds
     LEFT JOIN transactions t
       ON t.order_id = ds.transaction_id AND t.status = 'completed'
     LEFT JOIN plans p ON p.id = t.plan_id
     LEFT JOIN manual_subscription_grants g ON (
       g.deleted_at IS NULL
       AND g.id = CASE
         WHEN ds.transaction_id ~ '^manual_grant:[0-9]+$'
         THEN (substring(ds.transaction_id from 14))::bigint
       END
     )
     LEFT JOIN plans gp ON gp.id = g.plan_id
     WHERE LOWER(COALESCE(ds.status::text, '')) = 'active'
       AND ds.expires_at > now()
       AND ds.started_at IS NOT NULL
       AND COALESCE(t.plan_duration_days, p.duration_days, g.duration_days) IS NOT NULL
       AND COALESCE(t.plan_duration_days, p.duration_days, g.duration_days)
             > ${spanDaysSql('ds.started_at', 'ds.expires_at')} + 1
     ORDER BY ds.updated_at DESC
     LIMIT 2000`,
  )

  report.findings.mixed_metadata_active = mismatches.length
  report.samples = mismatches.slice(0, 30).map((r) => ({
    device_id: String(r.device_id).slice(0, 18) + (String(r.device_id).length > 18 ? '…' : ''),
    transaction_id: String(r.transaction_id ?? '').slice(0, 28),
    span_days: Number(r.span_days),
    remaining_days: Number(r.remaining_days),
    plan_days: Number(r.plan_days),
    amount: r.amount != null ? Number(r.amount) : null,
    plan_name: r.plan_name,
    activation_hint: r.activation_hint,
  }))

  const { rows: preserveVictims } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions ds
     JOIN transactions t ON t.order_id = ds.transaction_id AND t.status = 'completed'
     WHERE LOWER(COALESCE(ds.status::text, '')) = 'active'
       AND ds.expires_at > now()
       AND (
         t.raw_payload->'activation_result'->>'expiry_policy' = 'preserve_existing_active'
         OR t.raw_payload->'activation_result'->>'reason' = 'preserve_existing_active'
         OR t.raw_payload->'activation_result'->>'entitlement_unchanged' = 'true'
       )`,
  )
  report.findings.linked_txn_marked_preserve_existing = Number(preserveVictims[0]?.n) || 0

  const { rows: plans } = await pool.query(
    `SELECT id, name, price, duration_days, is_active
     FROM plans WHERE deleted_at IS NULL ORDER BY id ASC`,
  )
  report.plans = plans.map((p) => ({
    id: Number(p.id),
    name: String(p.name ?? ''),
    price: Number(p.price),
    durationDays: Number(p.duration_days),
    active: p.is_active === true,
  }))

  if (REPAIR) {
    for (const row of mismatches) {
      const deviceId = String(row.device_id)
      const before = String(row.transaction_id ?? '')
      const owner = await findOwnerTransactionId(
        pool,
        deviceId,
        row.expires_at,
        row.span_days,
      )
      if (!owner || owner === before) {
        report.skipped.push({
          device_id: deviceId.slice(0, 18) + (deviceId.length > 18 ? '…' : ''),
          reason: owner ? 'already_correct' : 'no_safe_owner',
          before,
          span_days: Number(row.span_days),
          plan_days: Number(row.plan_days),
        })
        continue
      }
      const upd = await pool.query(
        `UPDATE device_subscriptions
         SET transaction_id = $2, updated_at = now()
         WHERE device_id = $1
           AND transaction_id IS DISTINCT FROM $2
           AND status = 'active'
           AND expires_at > now()
           AND expires_at IS NOT DISTINCT FROM $3::timestamptz
         RETURNING device_id, transaction_id, expires_at`,
        [deviceId, owner, row.expires_at],
      )
      if (upd.rowCount > 0) {
        report.repaired.push({
          device_id: deviceId.slice(0, 18) + (deviceId.length > 18 ? '…' : ''),
          before,
          after: owner,
          span_days: Number(row.span_days),
          old_plan_days: Number(row.plan_days),
          expires_at: row.expires_at,
        })
      } else {
        report.skipped.push({
          device_id: deviceId.slice(0, 18) + (deviceId.length > 18 ? '…' : ''),
          reason: 'update_race_or_unchanged',
          before,
          owner,
        })
      }
    }
  }

  report.ok = true
  report.findings.repaired_count = report.repaired.length
  report.findings.skipped_count = report.skipped.length
  console.log(JSON.stringify(report, null, 2))
  await closePool().catch(() => {})
}

main().catch(async (e) => {
  console.error('[audit-account-plan-consistency] failed:', e)
  await closePool().catch(() => {})
  process.exit(1)
})
