/**
 * Production verify: manual-grant metadata vs grant history (read-only HTTP).
 * Usage: node server/scripts/verify-manual-grant-metadata-live.mjs [baseUrl] [adminToken]
 */
const base = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const adminToken = process.argv[3] || process.env.ADMIN_PANEL_TOKEN || '3030'

const EXPECT = {
  7: { amount: 3000, label: 'Wiki 1' },
  30: { amount: 5000, label: 'MWENZI 1' },
  60: { amount: 15000, label: 'MIEZI 2' },
  365: { amount: 40000, label: 'MWAKA' },
}

async function fetchJson(path, headers = {}) {
  const res = await fetch(`${base}${path}`, { headers })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

const health = await fetchJson('/api/health')
console.log('health.commit:', health.body?.commit)

const hist = await fetchJson('/api/admin/manual-subscription/history?limit=80', {
  'X-Admin-Token': adminToken,
})
const rows = Array.isArray(hist.body?.rows) ? hist.body.rows : []
if (!rows.length) {
  console.error('No manual grant history rows')
  process.exit(1)
}

/** Latest grant per device (newest created_at). */
const byDevice = new Map()
for (const r of rows) {
  const id = r.deviceId
  if (!id) continue
  const prev = byDevice.get(id)
  if (!prev || String(r.grantedAt) > String(prev.grantedAt)) byDevice.set(id, r)
}

let pass = 0
let fail = 0
const cases = []

for (const [deviceId, grant] of byDevice) {
  const days = Number(grant.durationDays)
  const exp = EXPECT[days]
  if (!exp) continue

  const v = await fetchJson(
    `/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`,
  )
  const apiDays = Number(v.body?.plan_duration_days ?? v.body?.planDurationDays)
  const apiAmount = Number(v.body?.amount)
  const ok = apiDays === days && apiAmount === exp.amount
  cases.push({
    deviceId,
    grantDays: days,
    apiDays,
    apiAmount,
    active: v.body?.active,
    ok,
  })
  if (ok) pass += 1
  else fail += 1
}

const regression = cases.find((c) => c.deviceId === 'c0972049aa5f862e')
if (regression) {
  console.log('\nRegression device c0972049aa5f862e (30d grant after Wiki payment):')
  console.log(regression)
}

console.log('\n=== Sample results (grant duration → API metadata) ===')
for (const c of cases.slice(0, 20)) {
  console.log(
    `${c.ok ? 'OK' : 'FAIL'} ${c.deviceId} grant=${c.grantDays}d api=${c.apiDays}d amount=${c.apiAmount} active=${c.active}`,
  )
}

console.log(`\nPassed ${pass} / ${pass + fail} devices with known plan durations`)

const needSamples = [30, 60, 365].filter((d) => !cases.some((c) => c.grantDays === d && c.ok))
if (needSamples.length) {
  console.warn('Missing passing samples for durations:', needSamples.join(', '))
}

if (fail > 0 || (regression && !regression.ok)) {
  process.exit(1)
}

console.log('Live metadata verification passed.')
