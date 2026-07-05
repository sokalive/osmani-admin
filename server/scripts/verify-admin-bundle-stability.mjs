#!/usr/bin/env node
/**
 * Verify Admin static bundles contain stale-while-revalidate stability markers.
 */
const SURFACES = [
  { label: 'VPS Admin', base: 'https://admin.osmanitv.com' },
  { label: 'Render Admin', base: 'https://osmani-admin-mpya.onrender.com' },
]

const MARKERS = [
  'osmani_admin_snap_v2',
  'osmani_admin_snap_v1',
  'Total Unique Devices',
  'Loading dashboard',
  'payment-orders',
  'subscription-requests',
  'device-control',
]

const API_ENDPOINTS = [
  { name: 'health', path: '/api/health', auth: false },
  { name: 'snapshot', path: '/api/analytics/snapshot', auth: true },
  { name: 'payment-orders', path: '/api/admin/payment-orders?limit=3', auth: true },
  { name: 'transactions', path: '/api/transactions', auth: true },
]

const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()

let failed = 0
function fail(m) {
  console.error('FAIL', m)
  failed++
}
function ok(m) {
  console.log('OK', m)
}

async function probeBundle(surface) {
  const t0 = performance.now()
  const html = await fetch(`${surface.base}/`, { cache: 'no-store' }).then((r) => r.text())
  const m = html.match(/src="(\/assets\/[^"]+\.js)"/)
  if (!m) {
    fail(`${surface.label}: no JS bundle in index.html`)
    return null
  }
  const bundlePath = m[1]
  const js = await fetch(`${surface.base}${bundlePath}`, { cache: 'no-store' }).then((r) => r.text())
  const ttfb = Math.round(performance.now() - t0)
  const hits = MARKERS.filter((k) => js.includes(k))
  const apiTarget =
    js.includes('https://api.osmanitv.com/api') || js.includes('api.osmanitv.com')
      ? 'VPS API'
      : js.includes('onrender.com')
        ? 'Render API'
        : 'same-origin /api'
  ok(`${surface.label} bundle=${bundlePath} apiTarget=${apiTarget} ttfb=${ttfb}ms markers=${hits.length}/${MARKERS.length}`)
  for (const k of MARKERS) {
    if (!js.includes(k)) fail(`${surface.label} missing marker: ${k}`)
  }
  return { bundlePath, hits, apiTarget, ttfb }
}

async function probeApiLatency(surface, path, auth) {
  const url = `${surface.base}${path}`
  const t0 = performance.now()
  const headers = auth ? { 'X-Admin-Token': TOKEN } : {}
  const res = await fetch(url, { cache: 'no-store', headers })
  const ms = Math.round(performance.now() - t0)
  return { status: res.status, ms }
}

async function main() {
  console.log('\n=== Admin Bundle + Latency Stability Audit ===\n')
  for (const surface of SURFACES) {
    console.log(`--- ${surface.label} (${surface.base}) ---`)
    const bundle = await probeBundle(surface)
    for (const ep of API_ENDPOINTS) {
      const r = await probeApiLatency(surface, ep.path, ep.auth)
      ok(`${surface.label} ${ep.name} HTTP ${r.status} ${r.ms}ms`)
    }
    if (bundle) {
      ok(`${surface.label} stability-fix-present=${bundle.hits.length >= 5}`)
    }
    console.log('')
  }
  console.log(`=== Done (${failed} failures) ===\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
