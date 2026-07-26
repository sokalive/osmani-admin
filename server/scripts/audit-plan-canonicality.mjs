/**
 * Production plan-canonicality audit + safe metadata repair.
 *
 * NEVER changes expires_at, remaining days, or entitlement status.
 * Only fills missing plan_id / plan_duration_days when the match is unique and unambiguous.
 *
 * Usage (on VPS with DATABASE_URL):
 *   node scripts/audit-plan-canonicality.mjs            # report only
 *   node scripts/audit-plan-canonicality.mjs --repair    # apply safe metadata fills
 */
import { getPool, closePool } from '../src/db/pool.js'

const REPAIR = process.argv.includes('--repair')

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

async function main() {
  const pool = requirePool()
  const report = {
    ok: true,
    repair: REPAIR,
    at: new Date().toISOString(),
    plans: [],
    findings: {},
    repaired: {},
  }

  const { rows: plans } = await pool.query(
    `SELECT id, name, price, duration_days, is_active
     FROM plans WHERE deleted_at IS NULL
     ORDER BY id ASC`,
  )
  report.plans = plans.map((p) => ({
    id: Number(p.id),
    name: String(p.name ?? ''),
    price: Number(p.price),
    durationDays: Number(p.duration_days),
    active: p.is_active === true,
  }))

  // --- Findings (read-only) ---

  const { rows: grantsMissingPlan } = await pool.query(
    `SELECT g.id, g.device_id, g.duration_days, g.plan_id, ds.expires_at
     FROM manual_subscription_grants g
     JOIN device_subscriptions ds
       ON ds.transaction_id = ('manual_grant:' || g.id::text)
     WHERE g.deleted_at IS NULL
       AND g.plan_id IS NULL
       AND LOWER(COALESCE(ds.status::text, '')) = 'active'
       AND ds.expires_at > now()
     ORDER BY g.created_at DESC
     LIMIT 500`,
  )
  report.findings.active_grants_missing_plan_id = grantsMissingPlan.length

  const { rows: grantsDurationMismatch } = await pool.query(
    `SELECT g.id, g.device_id, g.duration_days AS grant_days, p.duration_days AS plan_days,
            g.plan_id, p.name
     FROM manual_subscription_grants g
     JOIN device_subscriptions ds
       ON ds.transaction_id = ('manual_grant:' || g.id::text)
     JOIN plans p ON p.id = g.plan_id AND p.deleted_at IS NULL
     WHERE g.deleted_at IS NULL
       AND COALESCE(g.custom_expiry, false) = false
       AND LOWER(COALESCE(ds.status::text, '')) = 'active'
       AND ds.expires_at > now()
       AND g.duration_days IS DISTINCT FROM p.duration_days
     LIMIT 500`,
  )
  report.findings.active_grants_duration_vs_plan_mismatch = grantsDurationMismatch.length
  report.findings.active_grants_duration_vs_plan_samples = grantsDurationMismatch.slice(0, 20)

  const { rows: paidMissingPlan } = await pool.query(
    `SELECT ds.device_id, ds.transaction_id, t.plan_id, t.amount, t.plan_duration_days
     FROM device_subscriptions ds
     JOIN transactions t ON t.order_id = ds.transaction_id AND t.status = 'completed'
     WHERE LOWER(COALESCE(ds.status::text, '')) = 'active'
       AND ds.expires_at > now()
       AND ds.transaction_id NOT LIKE 'manual_grant:%'
       AND ds.transaction_id NOT LIKE 'moved:%'
       AND t.plan_id IS NULL
     LIMIT 500`,
  )
  report.findings.active_paid_missing_plan_id = paidMissingPlan.length

  const { rows: paidMissingDurationSnap } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions ds
     JOIN transactions t ON t.order_id = ds.transaction_id AND t.status = 'completed'
     WHERE LOWER(COALESCE(ds.status::text, '')) = 'active'
       AND ds.expires_at > now()
       AND ds.transaction_id NOT LIKE 'manual_grant:%'
       AND ds.transaction_id NOT LIKE 'moved:%'
       AND t.plan_id IS NOT NULL
       AND t.plan_duration_days IS NULL`,
  )
  report.findings.active_paid_missing_duration_snapshot = Number(paidMissingDurationSnap[0]?.n) || 0

  const { rows: offerNullPlan } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM offer_codes
     WHERE deleted_at IS NULL
       AND used_at IS NULL
       AND blocked IS NOT TRUE
       AND plan_id IS NULL
       AND expires_at > now()`,
  )
  report.findings.unused_offer_codes_missing_plan_id = Number(offerNullPlan[0]?.n) || 0

  // Amount vs live price is intentional purchase snapshot — report only, never "fix".
  const { rows: amountDrift } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions ds
     JOIN transactions t ON t.order_id = ds.transaction_id AND t.status = 'completed'
     JOIN plans p ON p.id = t.plan_id AND p.deleted_at IS NULL
     WHERE LOWER(COALESCE(ds.status::text, '')) = 'active'
       AND ds.expires_at > now()
       AND ds.transaction_id NOT LIKE 'manual_grant:%'
       AND t.amount IS DISTINCT FROM p.price`,
  )
  report.findings.active_paid_amount_vs_live_price_drift = Number(amountDrift[0]?.n) || 0
  report.findings.note =
    'amount_vs_live_price_drift is intentional (price at purchase). Never auto-corrected.'

  // --- Safe repairs (metadata only) ---

  if (REPAIR) {
    // 1) Fill grant.plan_id when exactly one active non-fixed plan matches duration.
    const fillGrants = await pool.query(
      `WITH candidates AS (
         SELECT g.id AS grant_id, p.id AS plan_id
         FROM manual_subscription_grants g
         JOIN device_subscriptions ds
           ON ds.transaction_id = ('manual_grant:' || g.id::text)
         JOIN plans p
           ON p.deleted_at IS NULL
          AND p.is_active = true
          AND p.expiry_type <> 'fixed'
          AND p.duration_days = g.duration_days
         WHERE g.deleted_at IS NULL
           AND g.plan_id IS NULL
           AND LOWER(COALESCE(ds.status::text, '')) = 'active'
           AND ds.expires_at > now()
         GROUP BY g.id, p.id
       ),
       unique_match AS (
         SELECT grant_id, MIN(plan_id) AS plan_id
         FROM candidates
         GROUP BY grant_id
         HAVING COUNT(*) = 1
       )
       UPDATE manual_subscription_grants g
       SET plan_id = u.plan_id
       FROM unique_match u
       WHERE g.id = u.grant_id
       RETURNING g.id, g.plan_id`,
    )
    report.repaired.grants_plan_id_filled = fillGrants.rowCount

    // 2) Mirror grant plan_id onto manual_grant transactions + amount from plan.
    const fillGrantTxns = await pool.query(
      `UPDATE transactions t
       SET plan_id = g.plan_id,
           amount = COALESCE(t.amount, p.price),
           plan_duration_days = COALESCE(t.plan_duration_days, g.duration_days, p.duration_days),
           updated_at = now()
       FROM manual_subscription_grants g
       JOIN plans p ON p.id = g.plan_id AND p.deleted_at IS NULL
       WHERE t.order_id = ('manual_grant:' || g.id::text)
         AND g.plan_id IS NOT NULL
         AND g.deleted_at IS NULL
         AND (t.plan_id IS NULL OR t.plan_duration_days IS NULL)
       RETURNING t.order_id`,
    )
    report.repaired.manual_grant_txns_plan_filled = fillGrantTxns.rowCount

    // 3) Backfill plan_duration_days on completed payment txns from live plan (legacy rows).
    const fillDuration = await pool.query(
      `UPDATE transactions t
       SET plan_duration_days = p.duration_days,
           updated_at = now()
       FROM plans p
       WHERE t.plan_id = p.id
         AND p.deleted_at IS NULL
         AND t.status = 'completed'
         AND t.plan_duration_days IS NULL
         AND p.duration_days IS NOT NULL
         AND p.duration_days >= 1
       RETURNING t.order_id`,
    )
    report.repaired.txn_duration_snapshots_filled = fillDuration.rowCount

    // 4) Unused offer codes: unique duration → plan_id.
    const fillOffers = await pool.query(
      `WITH candidates AS (
         SELECT oc.id AS code_id, p.id AS plan_id
         FROM offer_codes oc
         JOIN plans p
           ON p.deleted_at IS NULL
          AND p.is_active = true
          AND p.expiry_type <> 'fixed'
          AND p.duration_days = oc.duration_days
         WHERE oc.deleted_at IS NULL
           AND oc.used_at IS NULL
           AND oc.blocked IS NOT TRUE
           AND oc.plan_id IS NULL
           AND oc.expires_at > now()
         GROUP BY oc.id, p.id
       ),
       unique_match AS (
         SELECT code_id, MIN(plan_id) AS plan_id
         FROM candidates
         GROUP BY code_id
         HAVING COUNT(*) = 1
       )
       UPDATE offer_codes oc
       SET plan_id = u.plan_id
       FROM unique_match u
       WHERE oc.id = u.code_id
       RETURNING oc.id, oc.plan_id`,
    )
    report.repaired.offer_codes_plan_id_filled = fillOffers.rowCount
  }

  // Residual after repair
  const { rows: residualGrants } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM manual_subscription_grants g
     JOIN device_subscriptions ds
       ON ds.transaction_id = ('manual_grant:' || g.id::text)
     WHERE g.deleted_at IS NULL
       AND g.plan_id IS NULL
       AND LOWER(COALESCE(ds.status::text, '')) = 'active'
       AND ds.expires_at > now()`,
  )
  report.findings.residual_active_grants_missing_plan_id = Number(residualGrants[0]?.n) || 0

  // Hard fail only if paid active subs lack plan_id (Account cannot resolve package).
  if (report.findings.active_paid_missing_plan_id > 0) {
    report.ok = false
  }

  console.log(JSON.stringify(report, null, 2))
  await closePool().catch(() => {})
  process.exit(report.ok ? 0 : 1)
}

main().catch(async (e) => {
  console.error('[audit-plan-canonicality] failed:', e)
  await closePool().catch(() => {})
  process.exit(1)
})
