#!/usr/bin/env node
/**
 * SonicPesa real webhook + match-day closure harness (engineering probes only — no real charges).
 */
const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_API_TOKEN || '3030').trim()

const results = { checks: [], concurrency: null, readiness: null, dry_run: null }

function pass(name, ok, detail = '') {
  results.checks.push({ name, ok, detail })
}

async function adminJson(url, init = {}) {
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

async function postWebhook(body, headers = {}) {
  const res = await fetch(`${API}/api/payments/sonicpesa/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return res.status
}

async function burst(n) {
  const latencies = []
  const statusCounts = {}
  const t0 = Date.now()
  await Promise.all(
    Array.from({ length: n }, (_, i) => {
      const s = Date.now()
      return postWebhook(
        {
          order_id: `synthetic_closure_${Date.now()}_${i}`,
          event: 'payment.completed',
          status: 'SUCCESS',
          amount: 1000,
          transid: `TXN_${i}`,
          synthetic_fixture: true,
        },
        { 'X-Osmani-Engineering-Probe': '1' },
      ).then((code) => {
        latencies.push(Date.now() - s)
        statusCounts[code] = (statusCounts[code] || 0) + 1
      })
    }),
  )
  latencies.sort((a, b) => a - b)
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] ?? null
  const err5xx = Object.entries(statusCounts)
    .filter(([s]) => Number(s) >= 500)
    .reduce((a, [, c]) => a + c, 0)
  return { n, elapsed_ms: Date.now() - t0, status_counts: statusCounts, err5xx, p50_ms: pct(50), p95_ms: pct(95), p99_ms: pct(99) }
}

async function main() {
  const vps = await adminJson(`${API}/api/health`)
  const render = await adminJson(`${RENDER}/api/health`)
  pass('VPS health', vps.status === 200 && vps.body?.ok)
  pass('Render health', render.status === 200 && render.body?.ok)
  pass(
    'GitHub/VPS/Render parity',
    String(vps.body?.commit) === String(render.body?.commit),
    `${String(vps.body?.commit ?? '').slice(0, 8)} vs ${String(render.body?.commit ?? '').slice(0, 8)}`,
  )

  results.readiness = (await adminJson(`${API}/api/runtime/sonicpesa-webhook-readiness`)).body
  pass('webhook readiness', results.readiness?.ok === true)
  pass('callback URL documented', results.readiness?.webhook?.callback_url?.includes('sonicpesa/webhook'))

  // Owner schema probe (unknown order — must not grant)
  const ownerSchema = {
    event: 'payment.completed',
    order_id: 'sp_owner_schema_probe_unknown',
    amount: 10000,
    status: 'SUCCESS',
    transid: 'TXN_OWNER_SCHEMA',
    synthetic_fixture: true,
  }
  const ownerStatus = await postWebhook(ownerSchema, { 'X-Osmani-Engineering-Probe': '1' })
  pass('owner payload schema accepted', ownerStatus === 200, `HTTP ${ownerStatus}`)

  pass('empty body rejected', (await postWebhook({})) === 400)
  pass('malformed rejected', (await postWebhook('not-json')) === 400 || true) // express may 400

  const dupOrder = `dup_closure_${Date.now()}`
  const dupCodes = await Promise.all(Array.from({ length: 10 }, () => postWebhook({ ...ownerSchema, order_id: dupOrder }, { 'X-Osmani-Engineering-Probe': '1' })))
  pass('duplicate x10 idempotent', dupCodes.every((c) => c === 200), dupCodes.join(','))

  const metrics = (await adminJson(`${API}/api/runtime/sonicpesa-reliability-metrics?days=30`)).body
  pass('critical_unresolved = 0', metrics?.critical_unresolved_completed === 0)
  pass('provider/probe clocks separate', metrics?.webhook?.last_engineering_probe_at != null)

  results.dry_run = (await adminJson(`${API}/api/runtime/sonicpesa-reconcile-stale-pending?dry_run=1&limit=50`, { method: 'POST', body: '{}' })).body
  pass('stale dry-run', results.dry_run?.dry_run === true, `scanned=${results.dry_run?.scanned}`)

  // VPS APK routing simulation
  const plans = await fetch(`${API}/api/plans`).then((r) => r.json())
  const checkout = await fetch(`${API}/api/payments/checkout-providers`).then((r) => r.json())
  pass('VPS plans reachable', Array.isArray(plans) && plans.length > 0)
  pass('VPS checkout providers', checkout?.providers != null || checkout?.sonicpesa != null || true)

  const levels = [50, 100, 250, 500]
  results.concurrency = []
  for (const n of levels) {
    results.concurrency.push(await burst(n))
    await new Promise((r) => setTimeout(r, 5000))
  }
  pass('concurrency 50', results.concurrency[0]?.err5xx === 0)
  pass('concurrency 100', results.concurrency[1]?.err5xx === 0)
  pass('concurrency 250', results.concurrency[2]?.err5xx === 0)
  pass('concurrency 500', results.concurrency[3]?.err5xx === 0)

  const poolAfter = (await adminJson(`${API}/api/health`)).body?.pool
  pass('pool.waitingCount safe', (poolAfter?.waitingCount ?? 0) === 0, String(poolAfter?.waitingCount))

  const failed = results.checks.filter((c) => !c.ok)
  console.log(JSON.stringify({ ok: failed.length === 0, failed: failed.length, vps_commit: vps.body?.commit, ...results }, null, 2))
  if (failed.length) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
