/**
 * Production capacity validation — staged concurrent load against live VPS.
 *
 * Usage:
 *   node scripts/benchmark-vps-capacity.mjs
 *   VPS_API=https://api.osmanitv.com STAGES=200,300 node scripts/benchmark-vps-capacity.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const STAGES = (process.env.STAGES || '200,300,500,1000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
const COOLDOWN_MS = Math.max(5000, Number(process.env.CAPACITY_COOLDOWN_MS) || 20000)
const PREFIX = `cap_${Date.now()}`

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]
}

async function fetchJson(path, opts = {}) {
  const res = await fetch(`${VPS}${path}`, { cache: 'no-store', ...opts })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, ok: res.ok }
}

async function fetchHealthMetrics() {
  const h = await fetchJson('/api/health')
  const db = await fetchJson('/api/health/db')
  return {
    pool: h.json?.pool || db.json?.pg?.pool || {},
    verify_db: h.json?.verify_db || db.json?.verify_db || {},
    pg: db.json?.pg || {},
    process: db.json?.process || {},
  }
}

function peakMetrics(samples) {
  let peakPoolTotal = 0
  let peakWaiting = 0
  let peakVerifyInFlight = 0
  let peakDbConnections = 0
  let peakRamPct = null
  let peakCpuLoadPct = null
  for (const s of samples) {
    peakPoolTotal = Math.max(peakPoolTotal, s.pool?.totalCount ?? 0)
    peakWaiting = Math.max(peakWaiting, s.pool?.waitingCount ?? 0)
    peakVerifyInFlight = Math.max(peakVerifyInFlight, s.verify_db?.inFlight ?? 0)
    peakDbConnections = Math.max(peakDbConnections, s.pg?.active_connections ?? 0)
    if (s.process?.system_ram_used_pct != null) {
      peakRamPct = Math.max(peakRamPct ?? 0, s.process.system_ram_used_pct)
    }
    if (s.process?.cpu_load_pct_approx != null) {
      peakCpuLoadPct = Math.max(peakCpuLoadPct ?? 0, s.process.cpu_load_pct_approx)
    }
  }
  return {
    peakPoolTotal,
    peakWaiting,
    peakVerifyInFlight,
    peakDbConnections,
    peakRamPct,
    peakCpuLoadPct,
  }
}

function summarizeResults(results, n, peaks, elapsedMs) {
  const latencies = results.filter((r) => r.latencyMs > 0).map((r) => r.latencyMs).sort((a, b) => a - b)
  const ok = results.filter((r) => r.status === 200).length
  const err5 = results.filter((r) => r.status >= 500).length
  const err502 = results.filter((r) => r.status === 502).length
  const err0 = results.filter((r) => r.status === 0).length
  const dbTimeoutHints = results.filter((r) =>
    /timeout|db_pressure|502/i.test(String(r.bodySnippet || r.err || '')),
  ).length
  const avg = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : 0
  const p95 = percentile(latencies, 95)
  return {
    n,
    success: ok,
    failure: n - ok,
    http500: err5,
    http502: err502,
    networkErrors: err0,
    dbTimeoutHints,
    avgLatencyMs: avg,
    p95LatencyMs: p95,
    throughputRps: elapsedMs > 0 ? Math.round((ok / elapsedMs) * 1000 * 10) / 10 : 0,
    elapsedMs,
    pass: ok === n && err5 === 0,
    ...peaks,
  }
}

async function runLoad({ n, kind, paidDeviceIds, pollIntervalMs = 250 }) {
  const samples = []
  let stopPoll = false
  const pollPromise = (async () => {
    while (!stopPoll) {
      try {
        samples.push(await fetchHealthMetrics())
      } catch {
        /* ignore poll errors during burst */
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs))
    }
  })()

  const t0 = performance.now()
  const runId = `${PREFIX}_${kind}_${n}`
  const paidPool = paidDeviceIds.length ? paidDeviceIds : ['unknown']

  const tasks = Array.from({ length: n }, (_, i) => {
    const tReq = performance.now()
    let url = ''
    let opts = { cache: 'no-store' }
    const paidDeviceId = paidPool[i % paidPool.length]

    if (kind === 'verify_paid') {
      url = `${VPS}/api/subscription/verify`
      opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: paidDeviceId, version_code: 24 }),
        cache: 'no-store',
      }
    } else if (kind === 'verify_unpaid') {
      url = `${VPS}/api/subscription/verify`
      opts = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          device_id: `${runId}_unpaid_${i}`,
          version_code: 20 + (i % 5),
        }),
        cache: 'no-store',
      }
    } else {
      const roll = i % 10
      if (roll < 3) {
        url = `${VPS}/api/update-check?version_code=${roll < 2 ? 24 : 20}`
      } else if (roll < 6) {
        url = `${VPS}/api/subscription/verify`
        opts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: `${runId}_mix_v_${i}`,
            version_code: 23,
          }),
          cache: 'no-store',
        }
      } else if (roll < 8) {
        url = `${VPS}/api/subscription-status?device_id=${encodeURIComponent(`${runId}_mix_s_${i}`)}`
      } else {
        url = `${VPS}/api/subscription/verify`
        opts = {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: paidPool[i % paidPool.length], version_code: 24 }),
          cache: 'no-store',
        }
      }
    }

    return fetch(url, opts)
      .then(async (res) => {
        const text = await res.text()
        return {
          status: res.status,
          latencyMs: Math.round(performance.now() - tReq),
          bodySnippet: text.slice(0, 120),
        }
      })
      .catch((e) => ({
        status: 0,
        latencyMs: Math.round(performance.now() - tReq),
        err: String(e.message || e),
      }))
  })

  const results = await Promise.all(tasks)
  const elapsedMs = Math.round(performance.now() - t0)
  stopPoll = true
  await pollPromise.catch(() => {})

  const peaks = peakMetrics(samples)
  return summarizeResults(results, n, peaks, elapsedMs)
}

function printSummary(stage, label, s) {
  const flag = s.pass ? 'PASS' : 'FAIL'
  console.log(
    `${flag} Stage ${stage} ${label}: ${s.success}/${s.n} OK | 5xx=${s.http500} 502=${s.http502} netErr=${s.networkErrors} | avg=${s.avgLatencyMs}ms p95=${s.p95LatencyMs}ms | poolPeak=${s.peakPoolTotal} waitPeak=${s.peakWaiting} dbConnPeak=${s.peakDbConnections} ramPeak=${s.peakRamPct ?? 'n/a'}% cpuLoadPeak=${s.peakCpuLoadPct ?? 'n/a'}%`,
  )
}

async function cooldown(label) {
  console.log(`\n--- Cooldown ${COOLDOWN_MS / 1000}s after ${label} ---`)
  await new Promise((r) => setTimeout(r, COOLDOWN_MS))
}

async function main() {
  console.log(`VPS capacity validation → ${VPS}`)
  console.log(`Stages: ${STAGES.join(', ')}`)

  const baseline = await fetchJson('/api/health/db')
  const commit = baseline.json?.commit || 'unknown'
  console.log(`Live commit: ${commit}`)

  let paidDeviceIds = []
  if (process.env.PAID_DEVICE_ID) {
    paidDeviceIds = [String(process.env.PAID_DEVICE_ID).trim()]
  } else if (Array.isArray(baseline.json?.sample_active_device_ids)) {
    paidDeviceIds = baseline.json.sample_active_device_ids.map(String).filter(Boolean)
  } else if (baseline.json?.sample_active_device_id) {
    paidDeviceIds = [String(baseline.json.sample_active_device_id).trim()]
  }
  console.log(`Paid probe pool: ${paidDeviceIds.length} active device(s)`)
  if (!paidDeviceIds.length) {
    console.error('No paid devices available')
    process.exit(1)
  }

  const allResults = []

  for (const stage of STAGES) {
    console.log(`\n========== STAGE ${stage} users ==========`)

    const paid = await runLoad({ n: stage, kind: 'verify_paid', paidDeviceIds })
    printSummary(stage, 'verify_paid', paid)
    allResults.push({ stage, kind: 'verify_paid', ...paid })
    await cooldown(`stage ${stage} verify_paid`)

    const unpaid = await runLoad({ n: stage, kind: 'verify_unpaid', paidDeviceIds })
    printSummary(stage, 'verify_unpaid', unpaid)
    allResults.push({ stage, kind: 'verify_unpaid', ...unpaid })
    await cooldown(`stage ${stage} verify_unpaid`)

    const mixed = await runLoad({ n: stage, kind: 'mixed', paidDeviceIds })
    printSummary(stage, 'mixed', mixed)
    allResults.push({ stage, kind: 'mixed', ...mixed })
    await cooldown(`stage ${stage} mixed`)
  }

  console.log('\n========== CAPACITY SUMMARY JSON ==========')
  console.log(JSON.stringify({ commit, stages: allResults }, null, 2))

  const failed = allResults.filter((r) => !r.pass)
  if (failed.length) {
    console.log(`\nFAILED ${failed.length} test(s)`)
    process.exit(1)
  }
  console.log('\nAll capacity stages PASSED')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
