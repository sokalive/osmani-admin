/**
 * Smoke-test legacy APK API paths on Render (v16–v23).
 *
 * Usage:
 *   node scripts/verify-render-legacy-endpoints.mjs
 *   RENDER_API=https://osmani-admin-api.onrender.com node scripts/verify-render-legacy-endpoints.mjs
 */
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)
const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const PROBE_DEVICE = String(process.env.PROBE_DEVICE || 'render-legacy-probe')

const RENDER_ENDPOINTS = [
  { name: 'health', path: '/api/health' },
  { name: 'update-check', path: '/api/update-check?version_code=20' },
  { name: 'channels', path: '/api/channels' },
  { name: 'subscription-status', path: `/api/subscription-status?device_id=${encodeURIComponent(PROBE_DEVICE)}` },
  { name: 'checkout-providers', path: '/api/payments/checkout-providers' },
]

const VPS_ENDPOINTS = [{ name: 'health', path: '/api/health' }]

async function probe(base, endpoints, label) {
  const results = []
  for (const ep of endpoints) {
    const url = `${base}${ep.path}`
    const t0 = Date.now()
    try {
      const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(45_000) })
      const text = await res.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : null
      } catch {
        body = null
      }
      results.push({
        label,
        name: ep.name,
        url,
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        ms: Date.now() - t0,
        commit: body?.commit ?? null,
      })
    } catch (err) {
      results.push({
        label,
        name: ep.name,
        url,
        status: 0,
        ok: false,
        ms: Date.now() - t0,
        error: String(err?.message || err),
      })
    }
  }
  return results
}

const render = await probe(RENDER_API, RENDER_ENDPOINTS, 'Render')
const vps = await probe(VPS_API, VPS_ENDPOINTS, 'VPS')

const all = [...render, ...vps]
const failed = all.filter((r) => !r.ok)

console.log(JSON.stringify({ render, vps, failed: failed.length }, null, 2))

if (failed.length) {
  console.error('FAILED:', failed.map((f) => `${f.label} ${f.name} ${f.status || f.error}`).join(', '))
  process.exit(1)
}

console.log('OK: Render legacy + VPS health')
