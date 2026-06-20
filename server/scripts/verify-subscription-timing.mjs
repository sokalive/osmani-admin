/**
 * Verify update-check matrix v15–v24 and subscription verify latency on VPS + Render.
 *
 * Usage:
 *   node scripts/verify-subscription-timing.mjs
 *   VPS_API=https://api.osmanitv.com node scripts/verify-subscription-timing.mjs
 */
const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER_API = String(
  process.env.RENDER_API || 'https://osmani-admin-api.onrender.com',
).replace(/\/+$/, '')

const HOSTS = [
  { label: 'VPS', base: VPS_API },
  { label: 'Render', base: RENDER_API },
]

async function timedVerify(base, deviceId) {
  const url = `${base}/api/subscription-status?device_id=${encodeURIComponent(deviceId)}`
  const t0 = performance.now()
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  const ms = Math.round(performance.now() - t0)
  return { ms, status: res.status, active: body?.active === true || body?.isActive === true, body }
}

async function fetchUpdateCheck(base, v) {
  const res = await fetch(`${base}/api/update-check?version_code=${v}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  return res.json()
}

let failed = 0
function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}
function pass(msg) {
  console.log(`OK ${msg}`)
}

console.log('=== Update matrix v15–v24 ===')
for (const host of HOSTS) {
  console.log(`\n--- ${host.label} ---`)
  for (let v = 15; v <= 24; v++) {
    const data = await fetchUpdateCheck(host.base, v)
    const want = v >= 24 ? 'NONE' : 'SOFT'
    if (data.decision !== want) fail(`${host.label} v${v}: ${data.decision}, want ${want}`)
    else pass(`${host.label} v${v} => ${want}`)
  }
}

console.log('\n=== Subscription verify timing (3 consecutive calls) ===')
const probeDevice = `timing_probe_${Date.now()}`
const maxMs = Math.max(500, Number(process.env.SUBSCRIPTION_VERIFY_MAX_MS) || 2500)

for (const host of HOSTS) {
  const samples = []
  for (let i = 0; i < 3; i++) {
    const { ms, status } = await timedVerify(host.base, `${probeDevice}_${i}`)
    samples.push(ms)
    if (status !== 200) fail(`${host.label} verify call ${i + 1}: HTTP ${status}`)
  }
  const avg = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length)
  const max = Math.max(...samples)
  console.log(`${host.label}: ${samples.join('ms, ')}ms (avg ${avg}ms, max ${max}ms)`)
  if (max > maxMs) fail(`${host.label} verify max ${max}ms exceeds ${maxMs}ms budget`)
  else pass(`${host.label} verify within ${maxMs}ms budget`)
}

if (failed > 0) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nAll subscription timing checks passed.')
