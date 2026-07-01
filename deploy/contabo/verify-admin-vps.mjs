/**
 * Verify VPS admin frontend + admin API (post apply-cutover).
 *
 * Usage:
 *   node deploy/contabo/verify-admin-vps.mjs
 *   ADMIN_BASE=http://144.91.117.90 ADMIN_TOKEN=3030 node deploy/contabo/verify-admin-vps.mjs
 */
const ADMIN_BASE = String(process.env.ADMIN_BASE || 'https://admin.osmanitv.com').replace(/\/$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'
const RENDER_API = 'https://osmani-admin-api.onrender.com'

const checks = []

function pass(name, detail) {
  checks.push({ name, ok: true, detail })
  console.log(`✓ ${name}: ${detail}`)
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail })
  console.error(`✗ ${name}: ${detail}`)
}

async function fetchText(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const text = await res.text()
  return { res, text }
}

async function fetchJson(url, opts = {}) {
  const { res, text } = await fetchText(url, opts)
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body, text }
}

function adminHeaders() {
  return {
    'X-Admin-Token': ADMIN_TOKEN,
    'Content-Type': 'application/json',
  }
}

async function main() {
  console.log('=== VPS admin verification ===')
  console.log('ADMIN_BASE:', ADMIN_BASE)

  const home = await fetchText(`${ADMIN_BASE}/`)
  if (home.res.ok && home.text.includes('id="root"') && home.text.includes('/assets/')) {
    pass('admin-spa-shell', `HTTP ${home.res.status} index.html with /assets/`)
  } else {
    fail('admin-spa-shell', `status ${home.res.status} or missing SPA shell`)
  }

  const assetMatch = home.text.match(/src="(\/assets\/[^"]+\.js)"/)
  if (assetMatch) {
    const bundle = await fetchText(`${ADMIN_BASE}${assetMatch[1]}`)
    if (bundle.res.ok) {
      // Render host appears as mpya fallback even when VPS uses same-origin /api (var B=``).
      const usesRenderAsDefault = /var \w+=`https:\/\/osmani-admin-api\.onrender\.com`/.test(bundle.text)
      const usesSameOrigin = /var \w+=``/.test(bundle.text)
      if (usesRenderAsDefault) {
        fail('admin-bundle-api-origin', 'built JS defaults to Render API — rebuild with VITE_API_BASE_URL=')
      } else if (usesSameOrigin) {
        pass('admin-bundle-api-origin', 'same-origin /api (VITE_API_BASE_URL empty at build)')
      } else {
        fail('admin-bundle-api-origin', 'could not detect API base in bundle')
      }
    } else {
      fail('admin-bundle-fetch', `status ${bundle.res.status}`)
    }
  } else {
    fail('admin-bundle-path', 'no /assets/*.js in index.html')
  }

  const spaRoute = await fetchText(`${ADMIN_BASE}/channels`)
  if (spaRoute.res.ok && spaRoute.text.includes('id="root"')) {
    pass('admin-spa-routing', 'deep link /channels serves index.html')
  } else {
    fail('admin-spa-routing', `status ${spaRoute.res.status}`)
  }

  const auth = await fetchJson(`${ADMIN_BASE}/api/admin/auth/status`)
  if (auth.res.ok && typeof auth.body?.panelAuthRequired === 'boolean') {
    pass('admin-auth-status', `panelAuthRequired=${auth.body.panelAuthRequired}`)
  } else {
    fail('admin-auth-status', auth.body?.error || `status ${auth.res.status}`)
  }

  const adminRoutes = [
    ['channels', '/api/channels'],
    ['banners', '/api/banners'],
    ['plans', '/api/plans'],
    ['settings', '/api/settings'],
    ['payment-providers', '/api/settings/payment-providers'],
    ['app-update', '/api/settings/app-update'],
    ['zenopay', '/api/settings/zenopay'],
    ['panel-diagnostics', '/api/admin/panel-diagnostics'],
  ]

  for (const [name, path] of adminRoutes) {
    const { res, body } = await fetchJson(`${ADMIN_BASE}${path}`, { headers: adminHeaders() })
    if (res.status === 401 || res.status === 403) {
      fail(`admin-${name}`, `BLOCKED HTTP ${res.status}`)
      continue
    }
    if (!res.ok) {
      fail(`admin-${name}`, `HTTP ${res.status}`)
      continue
    }
    if (name === 'channels' && !Array.isArray(body)) fail(`admin-${name}`, 'expected array')
    else if (name === 'plans' && !Array.isArray(body)) fail(`admin-${name}`, 'expected array')
    else pass(`admin-${name}`, 'ok')
  }

  try {
    const [vpsPlans, renderPlans] = await Promise.all([
      fetchJson(`${ADMIN_BASE}/api/plans`),
      fetchJson(`${RENDER_API}/api/plans`),
    ])
    if (vpsPlans.res.ok && renderPlans.res.ok) {
      const l = vpsPlans.body.map((p) => `${p.id}:${p.activeSubscriberCount}`).join(',')
      const r = renderPlans.body.map((p) => `${p.id}:${p.activeSubscriberCount}`).join(',')
      if (l === r) pass('db-parity-render-api', 'plans match Render API (legacy APK unaffected)')
      else fail('db-parity-render-api', `vps=[${l}] render=[${r}]`)
    }
  } catch {
    console.log('  (skip db-parity — Render API unreachable)')
  }

  const failed = checks.filter((c) => !c.ok)
  console.log('\n=== Summary ===')
  console.log(JSON.stringify({ total: checks.length, failed: failed.length }, null, 2))
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
