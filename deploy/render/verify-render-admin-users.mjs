#!/usr/bin/env node
/**
 * Verify Render legacy admin (osmani-admin-mpya) Users / Subscriptions parity.
 *
 * Usage:
 *   node deploy/render/verify-render-admin-users.mjs
 *   ADMIN_TOKEN=3030 node deploy/render/verify-render-admin-users.mjs
 */
const RENDER_ADMIN = String(process.env.RENDER_ADMIN_BASE || 'https://osmani-admin-mpya.onrender.com').replace(
  /\/$/,
  '',
)
const RENDER_API = String(process.env.RENDER_API_BASE || 'https://osmani-admin-api.onrender.com').replace(
  /\/$/,
  '',
)
const TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'

const checks = []

function pass(name, detail) {
  checks.push({ name, ok: true, detail })
  console.log(`PASS ${name}: ${detail}`)
}

function fail(name, detail) {
  checks.push({ name, ok: false, detail })
  console.error(`FAIL ${name}: ${detail}`)
}

async function fetchJson(url, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const ms = Math.round(performance.now() - t0)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { res, body, ms, text }
}

function adminHeaders() {
  return { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' }
}

async function main() {
  console.log('=== Render admin users verification ===')
  console.log('RENDER_ADMIN:', RENDER_ADMIN)
  console.log('RENDER_API:', RENDER_API)

  const home = await fetchJson(`${RENDER_ADMIN}/`)
  const jsMatch = typeof home.text === 'string' ? home.text.match(/src="(\/assets\/[^"]+\.js)"/) : null
  if (!jsMatch) {
    fail('admin-spa-shell', 'missing /assets/*.js in index.html')
  } else {
    pass('admin-spa-shell', `bundle ${jsMatch[1]}`)
    const bundle = await fetchJson(`${RENDER_ADMIN}${jsMatch[1]}`)
    if (bundle.res.ok && String(bundle.text).includes('Active Paid')) {
      pass('admin-bundle-users-tabs', 'Users tab UI present in bundle')
    } else if (bundle.res.ok) {
      fail('admin-bundle-users-tabs', 'bundle missing Active Paid tab strings — redeploy osmani-admin-mpya')
    } else {
      fail('admin-bundle-fetch', `HTTP ${bundle.res.status}`)
    }
    if (bundle.res.ok && String(bundle.text).includes('osmani-admin-api.onrender.com')) {
      pass('admin-bundle-api-origin', 'bundle targets osmani-admin-api.onrender.com')
    } else if (bundle.res.ok) {
      fail(
        'admin-bundle-api-origin',
        'bundle may use same-origin /api on static host (causes empty users)',
      )
    }
  }

  const mpyaApiProbe = await fetchJson(`${RENDER_ADMIN}/api/users/summary`, { headers: adminHeaders() })
  if (typeof mpyaApiProbe.body === 'string' && mpyaApiProbe.body.includes('<!doctype html>')) {
    fail('mpya-same-origin-api', 'GET /api on static host returns HTML — expected; UI must use RENDER_API')
  } else {
    pass('mpya-same-origin-api', 'static /api not used as JSON (or proxied)')
  }

  const endpoints = [
    ['summary', '/api/users/summary'],
    ['active', '/api/users/active?page=1&limit=5'],
    ['expiring-24h', '/api/users/expiring?within=24h&page=1&limit=5'],
    ['failed', '/api/users/failed-payments?page=1&limit=5'],
    ['all', '/api/users?page=1&limit=5'],
    ['search-phone', '/api/users/active?search=255&page=1&limit=3'],
  ]

  for (const [name, path] of endpoints) {
    const { res, body, ms } = await fetchJson(`${RENDER_API}${path}`, { headers: adminHeaders() })
    if (!res.ok) {
      fail(`api-${name}`, `HTTP ${res.status} ${ms}ms`)
      continue
    }
    if (name === 'summary') {
      const s = body?.summary
      if (s && Number(s.active_paid) > 0) pass(`api-${name}`, `${ms}ms active_paid=${s.active_paid}`)
      else fail(`api-${name}`, `empty or invalid summary ${JSON.stringify(body).slice(0, 120)}`)
      continue
    }
    const n = Array.isArray(body?.items) ? body.items.length : 0
    const total = body?.pagination?.total
    if (n > 0) pass(`api-${name}`, `${ms}ms items=${n} total=${total}`)
    else fail(`api-${name}`, `${ms}ms no items (total=${total})`)
  }

  const cutover = await fetchJson(`${RENDER_API}/api/runtime/cutover-status`)
  if (cutover.res.ok && cutover.body?.commit) {
    pass('render-api-commit', String(cutover.body.commit).slice(0, 7))
  } else {
    fail('render-api-commit', `status ${cutover.res.status}`)
  }

  const failed = checks.filter((c) => !c.ok)
  console.log('\n=== Summary ===', { total: checks.length, failed: failed.length })
  process.exit(failed.length > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
