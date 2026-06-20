/**
 * Benchmark admin dashboard API endpoints (timing report).
 */
const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')

const ENDPOINTS = [
  '/api/health',
  '/api/analytics/snapshot',
  '/api/analytics/trend',
  '/api/channels',
  '/api/settings/public',
]

async function timedFetch(path) {
  const url = `${VPS_API}${path}`
  const start = performance.now()
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' })
  const ms = Math.round(performance.now() - start)
  const ok = res.ok
  let bytes = 0
  try {
    const text = await res.text()
    bytes = text.length
  } catch {
    /* ignore */
  }
  return { path, ms, status: res.status, ok, bytes }
}

console.log(`Benchmark ${VPS_API}\n`)

const dashboardParallel = performance.now()
const [snap, trend] = await Promise.all([
  timedFetch('/api/analytics/snapshot'),
  timedFetch('/api/analytics/trend'),
])
const parallelMs = Math.round(performance.now() - dashboardParallel)

for (const row of [snap, trend]) {
  console.log(`${row.path}: ${row.ms}ms HTTP ${row.status} (${row.bytes} bytes)`)
}
console.log(`dashboard parallel (snapshot+trend): ${parallelMs}ms\n`)

for (const path of ENDPOINTS.filter((p) => !['/api/analytics/snapshot', '/api/analytics/trend'].includes(p))) {
  const row = await timedFetch(path)
  console.log(`${row.path}: ${row.ms}ms HTTP ${row.status} (${row.bytes} bytes)`)
}
