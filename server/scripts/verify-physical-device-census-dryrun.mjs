#!/usr/bin/env node
/**
 * Physical-device census dry-run: 3 deterministic runs + stability checks.
 * Usage: node server/scripts/verify-physical-device-census-dryrun.mjs
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

async function fetchCensus(dryRun = true) {
  const t0 = performance.now()
  const q = dryRun ? '?dryRun=1&force=1' : '?force=1'
  const res = await fetch(`${VPS}/api/admin/analytics/physical-device-census${q}`, {
    cache: 'no-store',
    headers: { 'X-Admin-Token': TOKEN },
  })
  const ms = Math.round(performance.now() - t0)
  const body = await res.json().catch(() => null)
  return { status: res.status, body, ms }
}

async function main() {
  console.log(`\n=== Physical Device Census Dry-Run → ${VPS} ===\n`)

  const runs = []
  for (let i = 1; i <= 3; i++) {
    const r = await fetchCensus(true)
    if (r.status === 404) {
      fail('endpoint not deployed yet (404)')
      process.exit(1)
    }
    if (r.status === 409 || r.body?.aborted) {
      fail(`run ${i} ABORTED: ${JSON.stringify(r.body?.abortReasons)}`)
      console.log(JSON.stringify(r.body, null, 2))
      process.exit(1)
    }
    if (r.status !== 200 || !r.body?.ok) {
      fail(`run ${i} HTTP ${r.status}`)
      process.exit(1)
    }
    const count = r.body.counts?.physical_device_components_total
    runs.push(count)
    ok(
      `run ${i}: physical=${count} observed=${r.body.counts?.observed_raw_identities} high=${r.body.counts?.high_confidence_physical_devices} ambiguous=${r.body.counts?.ambiguous_low_confidence_components} buildMs=${r.body.buildMs} httpMs=${r.ms}`,
    )
    ok(`run ${i} component max=${r.body.component_statistics?.max} p95=${r.body.component_statistics?.p95}`)
  }

  if (runs[0] === runs[1] && runs[1] === runs[2]) {
    ok(`determinism PASS: ${runs[0]} x3 identical`)
  } else {
    fail(`determinism FAIL: ${runs.join(' → ')}`)
  }

  const snap1 = await fetch(`${VPS}/api/analytics/snapshot`, {
    cache: 'no-store',
    headers: { 'X-Admin-Token': TOKEN },
  }).then((r) => r.json())
  const snap2 = await fetch(`${VPS}/api/analytics/snapshot`, {
    cache: 'no-store',
    headers: { 'X-Admin-Token': TOKEN },
  }).then((r) => r.json())
  const u1 = snap1?.totalUniqueDevices
  const u2 = snap2?.totalUniqueDevices
  if (u1 === u2) ok(`snapshot stability: totalUniqueDevices=${u1} x2`)
  else fail(`snapshot drift: ${u1} → ${u2}`)

  const health = await fetch(`${VPS}/api/health`, { cache: 'no-store' }).then((r) => r.json())
  ok(`pool.waitingCount=${health.pool?.waitingCount}`)

  console.log('\n=== Reconciliation (run 3) ===')
  const last = await fetchCensus(true)
  console.log(JSON.stringify(last.body?.reconciliation, null, 2))
  console.log('\n=== Limitations ===')
  for (const l of last.body?.limitations || []) console.log('-', l)

  console.log(`\n=== Done (${failed} failures) ===\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
