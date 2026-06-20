/**
 * QA benchmark: subscription verify + SonicPesa lifecycle endpoints.
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')

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
  rows.push({
    endpoint: 'GET /api/subscription-status (inactive)',
    ...(await timedFetch(base, `/api/subscription-status?device_id=${probe}`)),
    active: false,
  })
  rows.push({
    endpoint: 'GET /api/subscription-status?order_id=probe (inactive+hint)',
    ...(await timedFetch(base, `/api/subscription-status?device_id=${probe}&order_id=osm_sp_fake_hint`)),
  })
  rows.push({
    endpoint: 'POST /api/subscription/verify',
    ...(await timedFetch(base, '/api/subscription/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ device_id: `${probe}_post`, version_code: 19 }),
    })),
  })
  rows.push({
    endpoint: 'GET /api/payments/checkout-providers',
    ...(await timedFetch(base, '/api/payments/checkout-providers')),
  })
  rows.push({
    endpoint: 'GET /api/sync/stream snapshot (health)',
    ...(await timedFetch(base, '/api/health')),
  })
  const health = await timedFetch(base, '/api/health')
  console.log(`\n=== ${label} (${base}) commit=${health.json?.commit?.slice?.(0, 7) ?? '?'} ===`)
  for (const r of rows) {
    const act = r.json?.active === true ? 'active' : r.json?.active === false ? 'inactive' : '-'
    console.log(`${r.endpoint}: ${r.ms}ms HTTP ${r.status} ${act} json=${r.parseOk}`)
  }
  return rows
}

console.log('Subscription/payment QA benchmark')
await benchHost('VPS', VPS)
await benchHost('Render', RENDER)
