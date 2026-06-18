/**
 * Investigate a device_id across production API + optional DATABASE_URL.
 *
 *   node scripts/investigate-device-subscription.mjs b874581a7c265864
 *   API_BASE=https://osmani-admin-api.onrender.com ADMIN_TOKEN=3030 node scripts/investigate-device-subscription.mjs <device_id>
 */
const deviceId = String(process.argv[2] || '').trim()
if (!deviceId) {
  console.error('Usage: node scripts/investigate-device-subscription.mjs <device_id>')
  process.exit(1)
}

const API_BASE = String(process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'
const YEARLY_PLAN_IDS = new Set([6])
const YEARLY_AMOUNTS = new Set([40000])

async function fetchJson(path, opts = {}) {
  const headers = {
    ...(opts.headers || {}),
    ...(path.startsWith('/api/admin') || path.startsWith('/api/transactions') || path.startsWith('/api/users')
      ? { 'X-Admin-Token': ADMIN_TOKEN }
      : {}),
  }
  const res = await fetch(`${API_BASE}${path}`, { cache: 'no-store', ...opts, headers })
  const body = await res.json().catch(() => null)
  return { res, body }
}

function planLabel(planId, amount) {
  if (planId === 6 || amount === 40000) return 'MWAKA (yearly)'
  if (planId === 5 || amount === 15000) return 'MIEZI 2'
  if (planId === 4 || amount === 5000) return 'MWENZI 1'
  if (planId === 3 || amount === 3000) return 'Wiki 1 (weekly)'
  return planId != null ? `plan ${planId}` : `amount ${amount}`
}

async function dbProbe() {
  const url = String(process.env.DATABASE_URL || '').trim()
  if (!url) return null
  const { default: pg } = await import('pg')
  const pool = new pg.Pool({
    connectionString: url,
    ssl: url.includes('localhost') || url.includes('127.0.0.1') ? false : { rejectUnauthorized: false },
  })
  const report = {}
  const q = async (name, sql, params) => {
    const { rows } = await pool.query(sql, params)
    report[name] = rows
    return rows
  }
  await q('device_subscriptions', `SELECT * FROM device_subscriptions WHERE device_id = $1 OR fingerprint_hash IN (
    SELECT fingerprint_hash FROM device_trial_entitlements WHERE device_id = $1 AND fingerprint_hash <> ''
  ) ORDER BY updated_at DESC`, [deviceId])
  await q('transactions', `SELECT order_id, device_id, phone, amount, status, plan_id, created_at, updated_at
    FROM transactions WHERE device_id = $1 OR phone IN (
      SELECT DISTINCT phone FROM transactions WHERE device_id = $1 AND phone IS NOT NULL AND phone <> ''
    ) ORDER BY created_at DESC LIMIT 50`, [deviceId])
  await q('trial_entitlements', `SELECT * FROM device_trial_entitlements WHERE device_id = $1 OR fingerprint_hash IN (
    SELECT fingerprint_hash FROM device_trial_entitlements WHERE device_id = $1
  ) ORDER BY updated_at DESC`, [deviceId])
  await q('subscription_recovery_log', `SELECT * FROM subscription_recovery_log
    WHERE source_device_id = $1 OR target_device_id = $1
    ORDER BY created_at DESC LIMIT 20`, [deviceId]).catch(() => [])
  await pool.end()
  return report
}

async function main() {
  console.log(`=== Device subscription investigation: ${deviceId} ===\n`)
  console.log(`API: ${API_BASE}\n`)

  const status = await fetchJson(`/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`)
  console.log('--- subscription-status (claimed device) ---')
  console.log(JSON.stringify(status.body, null, 2))

  const plans = await fetchJson('/api/plans')
  const planMap = new Map((Array.isArray(plans.body) ? plans.body : []).map((p) => [Number(p.id), p]))

  const txRes = await fetchJson('/api/transactions')
  const allTx = Array.isArray(txRes.body) ? txRes.body : []
  const deviceTx = allTx.filter((t) => String(t.device_id || '') === deviceId)
  const phones = [...new Set(deviceTx.map((t) => String(t.phone || '').trim()).filter(Boolean))]

  console.log('\n--- transactions for device_id ---')
  console.log(JSON.stringify(deviceTx, null, 2))

  let relatedTx = []
  if (phones.length) {
    relatedTx = allTx.filter((t) => phones.includes(String(t.phone || '').trim()))
    console.log('\n--- all transactions for phone(s):', phones.join(', '), '---')
    for (const t of relatedTx) {
      console.log(
        JSON.stringify({
          order_id: t.order_id,
          device_id: t.device_id,
          phone: t.phone,
          amount: t.amount,
          status: t.status,
          created_at: t.created_at,
          plan: planLabel(t.plan_id, t.amount),
        }),
      )
    }
  }

  const siblingDevices = [...new Set(relatedTx.map((t) => String(t.device_id || '')).filter(Boolean))]
  console.log('\n--- sibling device_ids (same phone) ---', siblingDevices)

  const siblingSubs = []
  for (const sid of siblingDevices) {
    const s = await fetchJson(`/api/subscription-status?device_id=${encodeURIComponent(sid)}`)
    siblingSubs.push({ device_id: sid, ...(s.body || {}) })
  }
  console.log('\n--- subscription-status per sibling device ---')
  console.log(JSON.stringify(siblingSubs, null, 2))

  const completed = relatedTx.filter((t) => t.status === 'completed')
  const yearlyCompleted = completed.filter(
    (t) => YEARLY_PLAN_IDS.has(Number(t.plan_id)) || YEARLY_AMOUNTS.has(Number(t.amount)),
  )

  console.log('\n--- yearly payment check ---')
  console.log(
    yearlyCompleted.length
      ? JSON.stringify(yearlyCompleted, null, 2)
      : 'No completed yearly (MWAKA/40000) payments found for this phone/device cluster.',
  )

  const db = await dbProbe()
  if (db) {
    console.log('\n--- DATABASE_URL direct queries ---')
    console.log(JSON.stringify(db, null, 2))
  }

  const activeSibling = siblingSubs.find((s) => s.active === true)
  const summary = {
    device_id: deviceId,
    claimed_active: status.body?.active === true,
    claimed_status: status.body?.status ?? null,
    phones,
    sibling_devices: siblingDevices,
    active_subscription_on_sibling: activeSibling
      ? {
          device_id: activeSibling.device_id,
          status: activeSibling.status,
          expires_at: activeSibling.expires_at,
          plan_duration_days: activeSibling.plan_duration_days,
          amount: activeSibling.amount,
        }
      : null,
    completed_payments_count: completed.length,
    yearly_completed_count: yearlyCompleted.length,
    pending_on_claimed_device: deviceTx.filter((t) => t.status === 'pending').length,
    migration_likely: Boolean(activeSibling && activeSibling.device_id !== deviceId),
    truthful_yearly_claim: yearlyCompleted.length > 0,
  }
  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(summary, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
