#!/usr/bin/env node
/**
 * Verify paginated Users / Subscriptions admin API (read-only probes).
 * Usage: node server/scripts/verify-users-admin.mjs [baseUrl]
 */
const base = (process.argv[2] || process.env.ADMIN_API_BASE || 'http://127.0.0.1:8787/api').replace(
  /\/$/,
  '',
)

async function probe(path, label) {
  const url = `${base}${path}`
  const headers = {}
  const token = process.env.ADMIN_PANEL_TOKEN || process.env.OSMANI_ADMIN_TOKEN || process.env.ADMIN_TOKEN || ''
  if (token) {
    headers['X-Admin-Token'] = token
    headers.Authorization = `Bearer ${token}`
  }
  const t0 = performance.now()
  const res = await fetch(url, { headers })
  const ms = Math.round(performance.now() - t0)
  const body = await res.json().catch(() => ({}))
  const ok = res.ok && body.ok !== false
  const count = Array.isArray(body.items)
    ? body.items.length
    : body.summary
      ? 'summary'
      : Array.isArray(body)
        ? body.length
        : '?'
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label} ${res.status} ${ms}ms items=${count}`)
  if (!ok) console.log('  ', JSON.stringify(body).slice(0, 200))
  return { ok, ms, body }
}

async function main() {
  console.log('[verify-users-admin] base:', base)
  const endpoints = [
    ['/users/summary', 'summary'],
    ['/users/active?page=1&limit=10', 'active paid'],
    ['/users/expiring?within=24h&page=1&limit=10', 'expiring 24h'],
    ['/users/expiring?within=3d&page=1&limit=10', 'expiring 3d'],
    ['/users/expiring?within=7d&page=1&limit=10', 'expiring 7d'],
    ['/users/failed-payments?page=1&limit=10', 'failed payments'],
    ['/users?page=1&limit=10', 'all paginated'],
    ['/users/active?search=255&page=1&limit=5', 'search phone prefix'],
  ]
  const results = []
  for (const [path, label] of endpoints) {
    results.push(await probe(path, label))
  }
  const slow = results.filter((r) => r.ms > 2000)
  if (slow.length) {
    console.error('[verify-users-admin] SLOW (>2s):', slow.length)
    process.exitCode = 1
  }
  const failed = results.filter((r) => !r.ok)
  if (failed.length) {
    console.error('[verify-users-admin] FAILED:', failed.length)
    process.exitCode = 1
  }
  console.log('[verify-users-admin] done')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
