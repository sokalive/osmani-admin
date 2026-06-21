/**
 * VPS latency benchmark — cold + warm cache passes.
 *
 * Usage:
 *   node scripts/benchmark-vps-latency.mjs
 *   VPS_API=https://api.osmanitv.com node scripts/benchmark-vps-latency.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')

async function timed(path, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(`${VPS}${path}`, { cache: 'no-store', ...opts })
  const text = await res.text()
  const ms = Math.round(performance.now() - t0)
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, ms, json, ok: res.ok }
}

async function runPass(label) {
  console.log(`\n=== ${label} ===`)
  const rows = []
  const health = await timed('/api/health')
  rows.push({ endpoint: 'GET /api/health', ...health, note: health.json?.commit?.slice(0, 12) })

  for (const v of [16, 20, 23, 24]) {
    const r = await timed(`/api/update-check?version_code=${v}`)
    rows.push({
      endpoint: `GET /api/update-check v${v}`,
      ...r,
      note: `${r.json?.decision || r.json?.error || '-'} ${r.json?.update_target_reason || ''}`.trim(),
    })
  }

  const probe = `bench_${label}_${Date.now()}`
  const status = await timed(`/api/subscription-status?device_id=${probe}`)
  rows.push({
    endpoint: 'GET /api/subscription-status',
    ...status,
    note: `active=${status.json?.active}`,
  })

  const verify = await timed('/api/subscription/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: `${probe}_v`, version_code: 20 }),
  })
  rows.push({
    endpoint: 'POST /api/subscription/verify',
    ...verify,
    note: `active=${verify.json?.active} plans=${verify.json?.plans?.length ?? 0}`,
  })

  const runtime = await timed('/api/runtime/app-update?version_code=20')
  rows.push({
    endpoint: 'GET /api/runtime/app-update v20',
    ...runtime,
    note: `${runtime.json?.decision || '-'}`,
  })

  for (const r of rows) {
    const flag = r.status >= 500 ? 'FAIL' : r.ms > 2000 ? 'SLOW' : 'OK'
    console.log(`${flag} ${r.endpoint}: ${r.ms}ms HTTP ${r.status} ${r.note || ''}`)
  }

  const errors = rows.filter((r) => r.status >= 500).length
  const slow = rows.filter((r) => r.ms > 2000 && r.status < 500).length
  return { rows, errors, slow }
}

console.log(`VPS latency benchmark → ${VPS}`)
const cold = await runPass('cold-start')
await runPass('warm-cache-pass-1')
const warm = await runPass('warm-cache-pass-2')

console.log('\n=== Summary ===')
console.log(`cold: ${cold.errors} HTTP 5xx, ${cold.slow} >2s (excl 5xx)`)
console.log(`warm pass 2: ${warm.errors} HTTP 5xx, ${warm.slow} >2s (excl 5xx)`)
if (cold.errors > 0 || warm.errors > 0) process.exit(1)
