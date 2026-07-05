#!/usr/bin/env node
/**
 * Production-safe Admin data stability + unique-device forensics (read-only).
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()

let failed = 0
function fail(m) {
  console.error('FAIL', m)
  failed++
}
function ok(m) {
  console.log('OK', m)
}

async function timedFetch(base, path, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(`${base}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const ms = Math.round(performance.now() - t0)
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { _raw: text.slice(0, 200) }
  }
  return { status: res.status, body, ms }
}

async function probeApi(label, base) {
  console.log(`\n--- ${label} (${base}) ---`)
  const health = await timedFetch(base, '/api/health', { headers: {} })
  if (health.status !== 200 || !health.body?.ok) fail(`${label} health HTTP ${health.status}`)
  else {
    ok(
      `${label} commit=${String(health.body.commit || '').slice(0, 12)} pool.wait=${health.body.pool?.waitingCount} ${health.ms}ms`,
    )
  }

  const snap = await timedFetch(base, '/api/analytics/snapshot')
  if (snap.status !== 200) fail(`${label} snapshot HTTP ${snap.status}`)
  else {
    ok(
      `${label} snapshot totalUniqueDevices=${snap.body?.totalUniqueDevices} online=${snap.body?.onlineNow} ${snap.ms}ms`,
    )
    if (snap.ms > 8000) fail(`${label} snapshot slow ${snap.ms}ms (>8s)`)
  }

  const orders = await timedFetch(base, '/api/admin/payment-orders?limit=5')
  if (orders.status !== 200) fail(`${label} payment-orders HTTP ${orders.status}`)
  else ok(`${label} payment-orders rows=${orders.body?.rows?.length ?? '?'} ${orders.ms}ms`)

  const tx = await timedFetch(base, '/api/transactions')
  if (tx.status !== 200) fail(`${label} transactions HTTP ${tx.status}`)
  else ok(`${label} transactions count=${Array.isArray(tx.body) ? tx.body.length : '?'} ${tx.ms}ms`)

  return { snap, health }
}

async function main() {
  console.log(`\n=== Admin Data Stability + Device Forensics ===\n`)

  await probeApi('VPS', VPS)
  await probeApi('Render', RENDER)

  const audit = await timedFetch(VPS, '/api/admin/analytics/unique-devices-audit')
  if (audit.status === 404) {
    ok('unique-devices-audit endpoint pending deploy (404)')
  } else if (audit.status !== 200) {
    fail(`unique-devices-audit HTTP ${audit.status}`)
  } else {
    const c = audit.body?.canonical?.totalUniqueDevices
    const mig = audit.body?.legacy_migration_metric
    ok(`canonical=${c} legacy_migration=${mig} ${audit.ms}ms`)
    ok(`label=${audit.body?.label}`)
    ok(`sources=${JSON.stringify(audit.body?.raw_sources || {})}`)
  }

  const migStats = await timedFetch(VPS, '/api/admin/app-version-migration/stats?limit=1')
  if (migStats.status === 200 && migStats.body?.summary) {
    ok(`migration stats totalUniqueDevices=${migStats.body.summary.totalUniqueDevices} ${migStats.ms}ms`)
  }

  // Repeat snapshot — canonical cache should reduce second-call latency
  const snap1 = await timedFetch(VPS, '/api/analytics/snapshot')
  const snap2 = await timedFetch(VPS, '/api/analytics/snapshot')
  ok(`snapshot repeat: ${snap1.ms}ms → ${snap2.ms}ms (warm canonical cache expected on 2nd)`)

  console.log(`\n=== Done (${failed} failures) ===\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
