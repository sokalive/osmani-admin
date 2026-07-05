#!/usr/bin/env node
/**
 * SonicPesa closure verification — production API probes + optional admin runtime ops.
 * Usage: VPS_API=https://api.osmanitv.com ADMIN_API_TOKEN=3030 node scripts/sonicpesa-closure-verification.mjs
 */
const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_API_TOKEN || process.env.ADMIN_TOKEN || '3030').trim()

const results = { checks: [], metrics: null, dry_run: null, critical_repair: null }

function pass(name, ok, detail = '') {
  results.checks.push({ name, ok, detail })
}

async function j(url, init = {}) {
  const res = await fetch(url, {
    ...init,
    headers: { 'x-admin-token': TOKEN, ...(init.headers || {}) },
  })
  const text = await res.text()
  let body = text
  try {
    body = JSON.parse(text)
  } catch {
    // keep
  }
  return { status: res.status, body }
}

async function main() {
  const health = await j(`${API}/api/health`)
  pass('VPS health', health.status === 200 && health.body?.ok === true, health.body?.commit?.slice(0, 12))

  const renderHealth = await j(`${RENDER}/api/health`)
  pass(
    'Render health',
    renderHealth.status === 200 && renderHealth.body?.ok === true,
    renderHealth.body?.commit?.slice(0, 12),
  )
  pass(
    'Render/VPS commit parity',
    String(health.body?.commit ?? '') === String(renderHealth.body?.commit ?? ''),
    `${String(health.body?.commit ?? '').slice(0, 8)} vs ${String(renderHealth.body?.commit ?? '').slice(0, 8)}`,
  )

  const forged = await fetch(`${API}/api/payments/sonicpesa/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Osmani-Engineering-Probe': '1' },
    body: JSON.stringify({
      order_id: 'synthetic_forged_success_closure',
      payment_status: 'SUCCESS',
      synthetic_fixture: true,
    }),
  })
  pass('forged unknown SUCCESS no grant', forged.status === 200, `HTTP ${forged.status}`)

  const empty = await fetch(`${API}/api/payments/sonicpesa/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  pass('empty payload rejected', empty.status === 400, `HTTP ${empty.status}`)

  const metrics = await j(`${API}/api/runtime/sonicpesa-reliability-metrics?days=30`)
  results.metrics = metrics.body
  pass('reliability metrics', metrics.status === 200 && metrics.body?.ok === true)
  pass(
    'provider webhook clock separate',
    metrics.body?.webhook?.last_provider_webhook_at !== undefined ||
      metrics.body?.webhook?.last_engineering_probe_at !== undefined,
  )

  const dryRun = await j(`${API}/api/runtime/sonicpesa-reconcile-stale-pending?dry_run=1&limit=25`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  results.dry_run = dryRun.body
  pass('stale pending dry-run', dryRun.status === 200 && dryRun.body?.dry_run === true, `scanned=${dryRun.body?.scanned}`)

  const critical = await j(`${API}/api/runtime/sonicpesa-repair-critical-unresolved`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  })
  results.critical_repair = critical.body
  pass(
    'critical repair executed',
    critical.status === 200 && critical.body?.ok === true,
    `critical=${critical.body?.critical_count} repairs=${critical.body?.repairs?.length}`,
  )

  const audit = await j(`${API}/api/runtime/payment-production-audit?days=30`)
  pass(
    'post-repair critical audit',
    audit.body?.critical_unresolved_completed === 0,
    `critical=${audit.body?.critical_unresolved_completed}`,
  )

  const failed = results.checks.filter((c) => !c.ok)
  console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.length, ...results }, null, 2))
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
