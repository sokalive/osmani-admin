#!/usr/bin/env node
/**
 * Safe concurrency probe with status distribution (engineering probes only).
 */
const API = process.env.VPS_API || 'https://api.osmanitv.com'
const levels = [50, 100, 250, 500]

async function burst(n) {
  const started = Date.now()
  const latencies = []
  const statusCounts = {}
  const tasks = Array.from({ length: n }, (_, i) => {
    const t0 = Date.now()
    return fetch(`${API}/api/payments/sonicpesa/webhook`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Osmani-Engineering-Probe': '1',
      },
      body: JSON.stringify({
        order_id: `synthetic_concurrency_${Date.now()}_${i}`,
        payment_status: 'SUCCESS',
        synthetic_fixture: true,
      }),
    }).then((r) => {
      latencies.push(Date.now() - t0)
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1
      return r.status
    })
  })
  await Promise.all(tasks)
  latencies.sort((a, b) => a - b)
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] ?? null
  const elapsed = Date.now() - started
  const err5xx = Object.entries(statusCounts)
    .filter(([s]) => Number(s) >= 500)
    .reduce((a, [, c]) => a + c, 0)
  return {
    n,
    elapsed_ms: elapsed,
    status_counts: statusCounts,
    err5xx,
    p50_ms: pct(50),
    p95_ms: pct(95),
    p99_ms: pct(99),
  }
}

async function waitPoolIdle(maxWaitMs = 60_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxWaitMs) {
    const h = await fetch(`${API}/api/health`).then((r) => r.json())
    if ((h.pool?.waitingCount ?? 0) === 0 && (h.pool?.idleCount ?? 0) > 0) return h.pool
    await new Promise((r) => setTimeout(r, 2000))
  }
  return null
}

async function main() {
  const healthBefore = await fetch(`${API}/api/health`).then((r) => r.json())
  const results = []
  for (const n of levels) {
    results.push(await burst(n))
    await waitPoolIdle()
    await new Promise((r) => setTimeout(r, 5000))
  }
  const healthAfter = await fetch(`${API}/api/health`).then((r) => r.json())
  const metrics = await fetch(`${API}/api/runtime/sonicpesa-reliability-metrics?days=30`, {
    headers: { 'x-admin-token': process.env.ADMIN_API_TOKEN || '3030' },
  }).then((r) => r.json())
  console.log(
    JSON.stringify(
      {
        commit: healthBefore.commit,
        pool_before: healthBefore.pool,
        pool_after: healthAfter.pool,
        inbox: metrics.inbox,
        results,
        pass: results.every((r) => r.err5xx === 0),
      },
      null,
      2,
    ),
  )
  if (!results.every((r) => r.err5xx === 0)) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
