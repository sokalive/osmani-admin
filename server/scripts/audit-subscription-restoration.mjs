/**
 * Production subscription restoration audit (read-only).
 * Requires DATABASE_URL (same Vultr DB as Render + VPS).
 *
 *   cd server && node scripts/audit-subscription-restoration.mjs
 */
import pg from 'pg'

const { Pool } = pg
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const VPS_API = String(process.env.VPS_API || 'http://144.91.117.90').replace(/\/$/, '')

const url = String(process.env.DATABASE_URL || '').trim()
if (!url) {
  console.error('DATABASE_URL required')
  process.exit(1)
}

const pool = new Pool({
  connectionString: url,
  ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
})

function pass(name, detail) {
  console.log(`✓ ${name}: ${detail}`)
}
function warn(name, detail) {
  console.warn(`⚠ ${name}: ${detail}`)
}
function fail(name, detail) {
  console.error(`✗ ${name}: ${detail}`)
}

async function fetchJson(u) {
  const res = await fetch(u, { cache: 'no-store' })
  const body = await res.json().catch(() => null)
  return { res, body }
}

async function main() {
  console.log('=== Subscription restoration audit ===\n')

  const activeSubs = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_subscriptions
     WHERE status = 'active' AND expires_at > now()`,
  )
  const activeCount = activeSubs.rows[0]?.n ?? 0
  pass('active-subscriptions', String(activeCount))

  const missingFp = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_subscriptions
     WHERE status = 'active' AND expires_at > now()
       AND (fingerprint_hash IS NULL OR fingerprint_hash = '')`,
  )
  const missingFpCount = missingFp.rows[0]?.n ?? 0
  if (missingFpCount > 0) {
    warn(
      'active-without-fingerprint_hash',
      `${missingFpCount} rows (verify will tag on next poll; trial-registry recover still works)`,
    )
  } else {
    pass('fingerprint-coverage', 'all active rows have fingerprint_hash')
  }

  const orphanCompleted = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM transactions t
     WHERE t.status = 'completed'
       AND t.plan_id IS NOT NULL
       AND COALESCE(t.device_id, '') <> ''
       AND NOT EXISTS (
         SELECT 1 FROM device_subscriptions ds
         WHERE ds.device_id = t.device_id
           AND ds.status = 'active'
           AND ds.expires_at > now()
       )`,
  )
  const orphanCount = orphanCompleted.rows[0]?.n ?? 0
  if (orphanCount > 0) {
    warn('completed-txn-without-active-sub', `${orphanCount} devices (tryFinalizeActivation repairs on verify)`)
  } else {
    pass('completed-txn-activation', 'no completed txns missing active subscription')
  }

  const pendingOld = await pool.query(
    `SELECT COUNT(*)::int AS n FROM transactions
     WHERE status = 'pending' AND created_at < now() - interval '30 minutes'`,
  )
  pass('stale-pending-txns-30m', String(pendingOld.rows[0]?.n ?? 0))

  const plans = await pool.query(
    `SELECT p.id, p.name, COUNT(ds.device_id)::int AS active_subs
     FROM plans p
     LEFT JOIN device_subscriptions ds
       ON ds.device_id IS NOT NULL
      AND ds.status = 'active'
      AND ds.expires_at > now()
      AND EXISTS (
        SELECT 1 FROM transactions t
        WHERE t.device_id = ds.device_id AND t.plan_id = p.id AND t.status = 'completed'
      )
     WHERE p.is_active = true AND p.deleted_at IS NULL
     GROUP BY p.id, p.name
     ORDER BY p.id`,
  )
  console.log('\nPlan distribution (completed txn link):')
  for (const row of plans.rows) {
    console.log(`  plan ${row.id} (${row.name}): ${row.active_subs}`)
  }

  console.log('\n=== Live API parity ===')
  for (const [label, base] of [
    ['Render', RENDER_API],
    ['VPS', VPS_API],
  ]) {
    const cutover = await fetchJson(`${base}/api/runtime/cutover-status`)
    const subs = cutover.body?.active_device_subscriptions
    pass(`${label}-cutover-subs`, String(subs ?? 'n/a'))
    const checkout = await fetchJson(`${base}/api/payments/checkout-providers`)
    pass(
      `${label}-checkout`,
      checkout.res.ok
        ? `provider=${checkout.body?.payment_provider} zenopay=${checkout.body?.zenopay} sonicpesa=${checkout.body?.sonicpesa}`
        : `HTTP ${checkout.res.status}`,
    )
    const payProbe = await fetch(`${base}/api/payments/create-payment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'null' },
      body: JSON.stringify({}),
    })
    const payOk = payProbe.status === 400 || payProbe.status === 422
    if (payOk) pass(`${label}-create-payment-reachable`, `HTTP ${payProbe.status} (validation, not 500)`)
    else fail(`${label}-create-payment-reachable`, `HTTP ${payProbe.status}`)
  }

  if (activeCount !== (await fetchJson(`${RENDER_API}/api/runtime/cutover-status`)).body?.active_device_subscriptions) {
    warn('render-db-parity', 'Render cutover count differs from direct DB query')
  } else {
    pass('render-db-parity', 'Render cutover matches DB')
  }

  await pool.end()
  console.log('\nAudit complete (read-only).')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
