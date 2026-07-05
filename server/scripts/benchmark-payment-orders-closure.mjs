#!/usr/bin/env node
/**
 * Payment Orders + health closure concurrency probe (engineering-safe endpoints only).
 */
const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
const LEVELS = [50, 100, 250, 500]

async function timedFetch(url, opts = {}) {
  const t0 = Date.now()
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const ms = Date.now() - t0
  return { status: res.status, ms }
}

async function burst(label, n, fn) {
  const latencies = []
  const statusCounts = {}
  const t0 = Date.now()
  await Promise.all(
    Array.from({ length: n }, async () => {
      const r = await fn()
      latencies.push(r.ms)
      statusCounts[r.status] = (statusCounts[r.status] || 0) + 1
    }),
  )
  latencies.sort((a, b) => a - b)
  const pct = (p) => latencies[Math.min(latencies.length - 1, Math.floor((latencies.length * p) / 100))] ?? 0
  const err5xx = Object.entries(statusCounts)
    .filter(([s]) => Number(s) >= 500)
    .reduce((a, [, c]) => a + c, 0)
  return {
    label,
    n,
    elapsed_ms: Date.now() - t0,
    status_counts: statusCounts,
    err5xx,
    p50_ms: pct(50),
    p95_ms: pct(95),
    p99_ms: pct(99),
  }
}

async function poolSnap() {
  const h = await fetch(`${API}/api/health`).then((r) => r.json())
  return h.pool ?? null
}

async function waitPool(maxMs = 90_000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const p = await poolSnap()
    if ((p?.waitingCount ?? 0) === 0) return p
    await new Promise((r) => setTimeout(r, 2000))
  }
  return await poolSnap()
}

async function main() {
  const before = await poolSnap()
  const health = await fetch(`${API}/api/health`).then((r) => r.json())
  const results = []

  for (const n of LEVELS) {
    results.push(
      await burst(`health-${n}`, n, () =>
        timedFetch(`${API}/api/health`),
      ),
    )
    await waitPool()
    results.push(
      await burst(`payment-orders-${n}`, n, () =>
        timedFetch(`${API}/api/admin/payment-orders?limit=3`, {
          headers: { 'X-Admin-Token': TOKEN },
        }),
      ),
    )
    await waitPool()
    await new Promise((r) => setTimeout(r, 3000))
  }

  const after = await waitPool()
  const pass = results.every((r) => r.err5xx === 0)
  console.log(
    JSON.stringify(
      {
        commit: health.commit,
        pool_before: before,
        pool_after: after,
        pass,
        results,
      },
      null,
      2,
    ),
  )
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
