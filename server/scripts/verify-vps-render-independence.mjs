/**
 * Verify VPS API responses do not depend on or reference Render at runtime.
 *
 * Usage:
 *   node scripts/verify-vps-render-independence.mjs
 *   BASE_URL=https://api.osmanitv.com node scripts/verify-vps-render-independence.mjs
 */
const BASE_URL = String(process.env.BASE_URL || process.env.VPS_API || 'https://api.osmanitv.com').replace(
  /\/$/,
  '',
)
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const CHECK_RENDER_DOWN = String(process.env.CHECK_RENDER_DOWN ?? '0').trim() === '1'

const PROBE_DEVICE = String(process.env.PROBE_DEVICE || 'vps-render-independence-probe')

const ENDPOINTS = [
  { name: 'health', path: '/api/health', method: 'GET' },
  { name: 'channels', path: '/api/channels', method: 'GET' },
  { name: 'banners', path: '/api/banners', method: 'GET' },
  { name: 'plans', path: '/api/plans', method: 'GET' },
  { name: 'settings', path: '/api/settings', method: 'GET' },
  { name: 'settings-public', path: '/api/settings/public', method: 'GET' },
  { name: 'server-health', path: '/api/server-health', method: 'GET' },
  { name: 'subscription-status', path: `/api/subscription-status?device_id=${encodeURIComponent(PROBE_DEVICE)}`, method: 'GET' },
  { name: 'checkout-providers', path: '/api/payments/checkout-providers', method: 'GET' },
  { name: 'update-check', path: '/api/update-check', method: 'GET' },
  { name: 'cutover-status', path: '/api/runtime/cutover-status', method: 'GET' },
  { name: 'runtime-app-modes', path: '/api/runtime/app-modes', method: 'GET' },
]

const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

function countRenderRefs(text) {
  return (String(text || '').match(/onrender\.com/gi) || []).length
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { res, text, body }
}

for (const ep of ENDPOINTS) {
  const url = `${BASE_URL}${ep.path}`
  try {
    const { res, text, body } = await fetchText(url, { method: ep.method })
    assert(
      `${ep.name} HTTP ${res.status}`,
      res.status >= 200 && res.status < 500,
      `${url} → ${res.status}`,
    )
    const renderRefs = countRenderRefs(text)
    const allowedLegacyListRefs =
      ep.name === 'cutover-status' && body?.cdn?.legacyOriginHosts
        ? countRenderRefs(JSON.stringify(body.cdn.legacyOriginHosts))
        : 0
    const actionableRenderRefs = Math.max(0, renderRefs - allowedLegacyListRefs)
    assert(
      `${ep.name} no Render URLs in body`,
      actionableRenderRefs === 0,
      actionableRenderRefs ? `${actionableRenderRefs} onrender.com ref(s) outside legacy host list` : '',
    )
    if (ep.name === 'channels' && Array.isArray(body) && body[0]) {
      const c0 = body[0]
      const urls = [
        c0.proxy_playback_url,
        c0.direct_stream_url,
        c0.playbackUrl,
        c0.thumbnailUrl,
        c0.thumbnail,
      ].filter(Boolean)
      const bad = urls.filter((u) => /onrender\.com/i.test(String(u)))
      assert(
        'channels[0] playback/thumbnail hosts',
        bad.length === 0,
        bad.join(' | ') || urls.slice(0, 2).join(' | '),
      )
    }
    if (ep.name === 'cutover-status' && body) {
      assert('cutover database configured', body.database_url_configured === true)
      assert('cutover pool ready', body.pool_ready === true)
      assert(
        'cutover base_url is VPS',
        String(body.base_url || '').includes('api.osmanitv.com'),
        String(body.base_url || ''),
      )
      assert(
        'cutover CDN origin is VPS',
        String(body.cdn?.originBaseUrl || '').includes('api.osmanitv.com'),
        String(body.cdn?.originBaseUrl || ''),
      )
      assert(
        'cutover DB host is Vultr (not Render)',
        String(body.database?.host || '').includes('155.138.223.205'),
        String(body.database?.host || ''),
      )
    }
    if (ep.name === 'subscription-status' && body) {
      assert('subscription-status JSON shape', typeof body.active === 'boolean')
    }
  } catch (e) {
    assert(`${ep.name} reachable`, false, String(e.message || e))
  }
}

if (CHECK_RENDER_DOWN) {
  try {
    const { res } = await fetchText(`${RENDER_API}/api/health`)
    assert(
      'Render API unreachable (simulated outage test)',
      !res.ok || res.status >= 500,
      `Render still returned HTTP ${res.status}`,
    )
  } catch {
    assert('Render API unreachable (simulated outage test)', true)
  }
}

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(c.ok ? 'OK' : 'FAIL', c.name, c.detail ? `— ${c.detail}` : '')
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed against ${BASE_URL}`)
  process.exit(1)
}

console.log(`\nVPS render-independence checks passed (${BASE_URL}).`)
console.log('Note: legacy Play Store APK builds hardcoded to Render are a separate client-side dependency.')
