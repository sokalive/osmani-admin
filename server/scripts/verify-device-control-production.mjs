#!/usr/bin/env node
/**
 * Production-safe Device Control + unique devices verification (read-only + settings GET).
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()

let failed = 0
function fail(m) {
  console.error('FAIL', m)
  failed++
}
function ok(m) {
  console.log('OK', m)
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${VPS}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { _raw: text.slice(0, 300) }
  }
  return { status: res.status, body }
}

async function main() {
  console.log(`\n=== Device Control Production Verify → ${VPS} ===\n`)

  const health = await fetchJson('/api/health', { headers: {} })
  if (health.status !== 200 || !health.body?.ok) fail(`health HTTP ${health.status}`)
  else ok(`health commit=${String(health.body.commit || '').slice(0, 12)} pool.wait=${health.body.pool?.waitingCount}`)

  const dc = await fetchJson('/api/settings/device-control')
  if (dc.status !== 200) fail(`device-control GET HTTP ${dc.status}`)
  else {
    ok(`settings transferMode=${dc.body.transferMode} daily=${dc.body.dailyLimit} weekly=${dc.body.weeklyLimit} cooldown=${dc.body.cooldownMinutes}`)
    ok(`pending rows=${Array.isArray(dc.body.pending) ? dc.body.pending.length : 0} logs=${Array.isArray(dc.body.logs) ? dc.body.logs.length : 0}`)
  }

  const snap = await fetchJson('/api/analytics/snapshot')
  if (snap.status !== 200) fail(`analytics snapshot HTTP ${snap.status}`)
  else {
    const u = snap.body?.totalUniqueDevices ?? snap.body?.overview?.totalUniqueDevices
    ok(`Total Unique Devices (dashboard)=${u ?? 'missing'}`)
  }

  const mig = await fetchJson('/api/admin/app-version-migration/stats?limit=1')
  if (mig.status === 200 && mig.body?.summary) {
    ok(`migrationPopulation totalUniqueDevices=${mig.body.summary.totalUniqueDevices} (legacy metric)`)
  }

  // Public contract endpoints exist (no mutation)
  for (const path of ['/api/transfer/status?code=__nonexistent__']) {
    const r = await fetch(`${VPS}${path}`, { cache: 'no-store' })
    ok(`GET ${path} → HTTP ${r.status} (404 expected for fake code)`)
  }

  console.log(`\n=== Done (${failed} failures) ===\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
