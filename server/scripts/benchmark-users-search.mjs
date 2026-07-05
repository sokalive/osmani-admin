#!/usr/bin/env node
/**
 * Users admin search latency probe (read-only).
 */
const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()

async function timed(path) {
  const t0 = Date.now()
  const res = await fetch(`${API}${path}`, {
    cache: 'no-store',
    headers: { 'X-Admin-Token': TOKEN },
  })
  const ms = Date.now() - t0
  return { status: res.status, ms }
}

async function main() {
  const health = await fetch(`${API}/api/health`).then((r) => r.json())
  const queries = [
    ['phone-prefix', '/api/users/active?search=255742&page=1&limit=25'],
    ['device-exact', '/api/users/active?page=1&limit=5&search=' + 'a'.repeat(64)],
    ['order-fragment', '/api/users/?page=1&limit=25&search=osm_sp'],
  ]
  const results = []
  for (const [label, path] of queries) {
    const samples = []
    for (let i = 0; i < 5; i++) samples.push(await timed(path))
    samples.sort((a, b) => a.ms - b.ms)
    const pct = (p) => samples[Math.min(samples.length - 1, Math.floor((samples.length * p) / 100))]?.ms ?? 0
    results.push({
      label,
      status: samples[0]?.status,
      p50_ms: pct(50),
      p95_ms: pct(95),
      p99_ms: pct(99),
    })
  }
  const pool = health.pool
  console.log(JSON.stringify({ commit: health.commit, pool, results }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
