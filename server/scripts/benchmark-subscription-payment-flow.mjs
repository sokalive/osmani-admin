/**
 * Benchmark subscription/payment endpoints for unpaid-user flow.
 */
const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')

async function timed(label, fn) {
  const t0 = performance.now()
  const res = await fn()
  const ms = Math.round(performance.now() - t0)
  return { label, ms, ...res }
}

async function get(path) {
  const url = `${VPS_API}${path}`
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, active: body?.active === true, bytes: JSON.stringify(body).length }
}

async function post(path, body) {
  const url = `${VPS_API}${path}`
  const res = await fetch(url, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok, active: json?.active === true, bytes: JSON.stringify(json).length }
}

const probe = `unpaid_probe_${Date.now()}`

console.log(`Benchmark ${VPS_API} probe=${probe}\n`)

const health = await timed('health', () => get('/api/health'))
console.log(`${health.label}: ${health.ms}ms HTTP ${health.status}`)

const endpoints = [
  ['GET subscription-status (new device)', () => get(`/api/subscription-status?device_id=${encodeURIComponent(probe)}`)],
  ['POST subscription/verify (new device)', () => post('/api/subscription/verify', { device_id: `${probe}_post` })],
  ['GET subscription-status (repeat)', () => get(`/api/subscription-status?device_id=${encodeURIComponent(probe)}`)],
  ['GET checkout-providers', () => get('/api/payments/checkout-providers')],
  ['GET plans', () => get('/api/plans')],
  ['GET settings/public', () => get('/api/settings/public')],
]

for (const [label, fn] of endpoints) {
  const r = await timed(label, fn)
  console.log(`${r.label}: ${r.ms}ms HTTP ${r.status} active=${r.active} (${r.bytes}b)`)
}
