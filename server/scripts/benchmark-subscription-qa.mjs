/**
 * QA benchmark: subscription verify + premium gate endpoints (VPS).
 *
 * Optional env:
 *   VPS_API=https://api.osmanitv.com
 *   BENCH_ACTIVE_DEVICE_ID=<known active subscriber>
 *   BENCH_STALE_ORDER_ID=<old pending/completed order_id stored on device>
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const ACTIVE_DEVICE = String(process.env.BENCH_ACTIVE_DEVICE_ID || '').trim()
const STALE_ORDER = String(process.env.BENCH_STALE_ORDER_ID || 'osm_sp_fake_stale_hint').trim()

async function timedFetch(base, path, opts = {}) {
  const url = `${base}${path}`
  const t0 = performance.now()
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  const ms = Math.round(performance.now() - t0)
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { ms, status: res.status, json, parseOk: json !== null || !text.trim() }
}

async function benchHost(label, base) {
  const probe = `qa_${Date.now()}`
  const rows = []
  const health = await timedFetch(base, '/api/health')

  rows.push({
    endpoint: 'GET /api/subscription-status (inactive)',
    ...(await timedFetch(base, `/api/subscription-status?device_id=${probe}`)),
  })
  rows.push({
    endpoint: 'GET /api/subscription-status?order_id=stale-hint (inactive)',
    ...(await timedFetch(
      base,
      `/api/subscription-status?device_id=${probe}&order_id=${encodeURIComponent(STALE_ORDER)}`,
    )),
  })
  rows.push({
    endpoint: 'POST /api/subscription/verify (inactive)',
    ...(await timedFetch(base, '/api/subscription/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device_id: `${probe}_post`, version_code: 19 }),
    })),
  })
  rows.push({
    endpoint: 'POST /api/subscription/verify (inactive+stale order_id)',
    ...(await timedFetch(base, '/api/subscription/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        device_id: `${probe}_stale`,
        order_id: STALE_ORDER,
        version_code: 19,
      }),
    })),
  })
  rows.push({
    endpoint: 'GET /api/plans',
    ...(await timedFetch(base, '/api/plans')),
  })
  rows.push({
    endpoint: 'GET /api/payments/checkout-providers',
    ...(await timedFetch(base, '/api/payments/checkout-providers')),
  })

  if (ACTIVE_DEVICE) {
    rows.push({
      endpoint: `GET /api/subscription-status (active device ${ACTIVE_DEVICE.slice(0, 12)}…)`,
      ...(await timedFetch(base, `/api/subscription-status?device_id=${encodeURIComponent(ACTIVE_DEVICE)}`)),
    })
    rows.push({
      endpoint: `POST /api/subscription/verify (active+stale order_id)`,
      ...(await timedFetch(base, '/api/subscription/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          device_id: ACTIVE_DEVICE,
          order_id: STALE_ORDER,
          version_code: 19,
        }),
      })),
    })
  }

  console.log(`\n=== ${label} (${base}) commit=${health.json?.commit?.slice?.(0, 7) ?? '?'} ===`)
  for (const r of rows) {
    const act =
      r.json?.active === true ? 'active' : r.json?.active === false || r.json?.isActive === false ? 'inactive' : '-'
    console.log(`${r.endpoint}: ${r.ms}ms HTTP ${r.status} ${act} json=${r.parseOk}`)
  }
  return { rows, commit: health.json?.commit }
}

console.log('Subscription/payment QA benchmark')
const beforeNote = process.env.BENCH_LABEL || 'run'
console.log(`label=${beforeNote} stale_order_hint=${STALE_ORDER}`)
const vps = await benchHost('VPS', VPS)
await benchHost('Render', RENDER)
console.log('\nSet BENCH_ACTIVE_DEVICE_ID for active-subscriber timings.')
