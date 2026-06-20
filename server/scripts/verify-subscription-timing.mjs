/**
 * Verify subscription verify latency for unpaid (new device) probes.
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
  return { ms, status: res.status, active: body?.active === true, plans: Array.isArray(body?.plans) ? body.plans.length : 0 }
}

let failed = 0
function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}
function pass(msg) {
  console.log(`OK ${msg}`)
}

console.log('=== Subscription verify timing (unpaid new device, 3 calls) ===')
const probeDevice = `timing_probe_${Date.now()}`
const maxMs = Math.max(500, Number(process.env.SUBSCRIPTION_VERIFY_MAX_MS) || 2500)

for (const host of HOSTS) {
  const health = await fetch(`${host.base}/api/health`, { cache: 'no-store' })
    .then((r) => r.json())
    .catch(() => ({}))
  if (health?.commit) pass(`${host.label} commit ${String(health.commit).slice(0, 7)}`)

  const samples = []
  for (let i = 0; i < 3; i++) {
    const { ms, status, active, plans } = await timedVerify(host.base, `${probeDevice}_${i}`)
    samples.push(ms)
    if (status !== 200) fail(`${host.label} verify call ${i + 1}: HTTP ${status}`)
    if (active) fail(`${host.label} verify call ${i + 1}: expected inactive`)
    if (plans <= 0) fail(`${host.label} verify call ${i + 1}: missing plans`)
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
