#!/usr/bin/env node
/**
 * Staged sustained capacity regression for post-67a45db pool validation.
 * Safe: verify/update-check/settings reads only — no payments, grants, SMS, or admin writes.
 *
 * Usage:
 *   PAID_DEVICE_ID=85970ee4273c6ca8 node scripts/capacity-regression-staged.mjs
 *   STAGES=50,100 STAGE_DURATION_SEC=60 node scripts/capacity-regression-staged.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const STAGES = (process.env.STAGES || '50,100,200,300,500')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
const STAGE_DURATION_SEC = Math.max(30, Math.min(300, Number(process.env.STAGE_DURATION_SEC) || 90))
const COOLDOWN_SEC = Math.max(20, Math.min(120, Number(process.env.COOLDOWN_SEC) || 45))
const RAMP_SEC = Math.max(5, Math.min(60, Number(process.env.RAMP_SEC) || 20))
const ABORT_WAITING = Math.max(50, Number(process.env.ABORT_WAITING_COUNT) || 200)
const ABORT_5XX_RATE = Math.max(0.05, Number(process.env.ABORT_5XX_RATE) || 0.15)
const PAID_DEVICE_ID = String(process.env.PAID_DEVICE_ID || '85970ee4273c6ca8').trim()
const PREFIX = `cap67_${Date.now()}`

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
  return { status: res.status, json, text: text.slice(0, 200) }
}

async function fetchHealth() {
  const h = await fetchJson('/api/health')
  return {
    pool: h.json?.pool || {},
    verify_db: h.json?.verify_db || {},
    commit: h.json?.commit,
    uptime: h.json?.startup?.uptime_sec,
  }
}

async function fetchHealthDb() {
  const db = await fetchJson('/api/health/db')
  return {
    pg: db.json?.pg || {},
    process: db.json?.process || {},
    pool: db.json?.pg?.pool || db.json?.verify_db?.pool || {},
  }
}

function pickRequest(i, runId) {
  const roll = i % 20
  const t0 = performance.now()
  if (roll < 8) {
    return {
      label: 'verify_unpaid',
      run: () =>
        fetch(`${VPS}/api/subscription/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: `${runId}_u_${i}`,
            version_code: 20 + (i % 5),
          }),
          cache: 'no-store',
        }).then(async (res) => ({
          status: res.status,
          latencyMs: Math.round(performance.now() - t0),
          body: (await res.text()).slice(0, 120),
        })),
    }
  }
  if (roll < 12) {
    return {
      label: 'verify_paid',
      run: () =>
        fetch(`${VPS}/api/subscription/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: PAID_DEVICE_ID, version_code: 24 }),
          cache: 'no-store',
        }).then(async (res) => ({
          status: res.status,
          latencyMs: Math.round(performance.now() - t0),
          body: (await res.text()).slice(0, 120),
        })),
    }
  }
  if (roll < 15) {
    return {
      label: 'update_check',
      run: () =>
        fetch(`${VPS}/api/update-check?version_code=${22 + (i % 3)}`, { cache: 'no-store' }).then(async (res) => ({
          status: res.status,
          latencyMs: Math.round(performance.now() - t0),
          body: (await res.text()).slice(0, 120),
        })),
    }
  }
  if (roll < 18) {
    const did = `${runId}_s_${i}`
    return {
      label: 'subscription_status',
      run: () =>
        fetch(`${VPS}/api/subscription-status?device_id=${encodeURIComponent(did)}`, {
          cache: 'no-store',
        }).then(async (res) => ({
          status: res.status,
          latencyMs: Math.round(performance.now() - t0),
          body: (await res.text()).slice(0, 120),
        })),
    }
  }
  return {
    label: 'sub_req_settings',
    run: () =>
      fetch(`${VPS}/api/subscription-request/settings`, { cache: 'no-store' }).then(async (res) => ({
        status: res.status,
        latencyMs: Math.round(performance.now() - t0),
        body: (await res.text()).slice(0, 120),
      })),
  }
}

async function runSustainedStage(concurrency) {
  const runId = `${PREFIX}_${concurrency}`
  const results = []
  const metricsSamples = []
  let aborted = false
  let abortReason = null
  let inFlight = 0
  let seq = 0
  let stop = false

  const poll = (async () => {
    while (!stop) {
      try {
        const [h, db] = await Promise.all([fetchHealth(), fetchHealthDb()])
        metricsSamples.push({
          t: Date.now(),
          pool: h.pool,
          verify_db: h.verify_db,
          pg: db.pg,
          process: db.process,
        })
        const waiting = h.pool?.waitingCount ?? 0
        if (waiting >= ABORT_WAITING) {
          aborted = true
          abortReason = `waitingCount=${waiting} >= ${ABORT_WAITING}`
          stop = true
        }
      } catch {
        /* ignore poll errors */
      }
      await new Promise((r) => setTimeout(r, 2000))
    }
  })()

  const stageStart = performance.now()
  const rampEnd = stageStart + RAMP_SEC * 1000
  const sustainEnd = stageStart + (RAMP_SEC + STAGE_DURATION_SEC) * 1000

  async function worker() {
    while (!stop && performance.now() < sustainEnd) {
      const now = performance.now()
      if (now < rampEnd) {
        const target = Math.ceil(((now - stageStart) / (RAMP_SEC * 1000)) * concurrency)
        if (inFlight >= Math.max(1, target)) {
          await new Promise((r) => setTimeout(r, 50))
          continue
        }
      }
      inFlight += 1
      const i = seq++
      const req = pickRequest(i, runId)
      try {
        const r = await req.run()
        results.push({ ...r, label: req.label })
        if (results.length >= 20) {
          const recent = results.slice(-20)
          const err5 = recent.filter((x) => x.status >= 500).length
          if (err5 / recent.length >= ABORT_5XX_RATE) {
            aborted = true
            abortReason = `5xx rate ${((err5 / recent.length) * 100).toFixed(1)}% on last 20 requests`
            stop = true
          }
        }
      } catch (e) {
        results.push({ status: 0, latencyMs: 0, body: String(e?.message || e), label: 'error' })
      } finally {
        inFlight -= 1
      }
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker())
  await Promise.all(workers)
  stop = true
  await poll.catch(() => {})

  const latencies = results.filter((r) => r.latencyMs > 0).map((r) => r.latencyMs).sort((a, b) => a - b)
  const ok = results.filter((r) => r.status >= 200 && r.status < 300).length
  const err5 = results.filter((r) => r.status >= 500).length
  const err4 = results.filter((r) => r.status >= 400 && r.status < 500).length
  const timeouts = results.filter((r) => /timeout|db_pressure/i.test(String(r.body))).length

  let peakWaiting = 0
  let peakPoolTotal = 0
  let peakVerifyInFlight = 0
  let peakPgActive = 0
  let peakCpu = null
  let peakRam = null
  let endWaiting = null
  let endIdle = null
  for (const s of metricsSamples) {
    peakWaiting = Math.max(peakWaiting, s.pool?.waitingCount ?? 0)
    peakPoolTotal = Math.max(peakPoolTotal, s.pool?.totalCount ?? 0)
    peakVerifyInFlight = Math.max(peakVerifyInFlight, s.verify_db?.inFlight ?? 0)
    peakPgActive = Math.max(peakPgActive, s.pg?.active_connections ?? 0)
    if (s.process?.cpu_load_pct_approx != null) peakCpu = Math.max(peakCpu ?? 0, s.process.cpu_load_pct_approx)
    if (s.process?.system_ram_used_pct != null) peakRam = Math.max(peakRam ?? 0, s.process.system_ram_used_pct)
  }
  const last = metricsSamples[metricsSamples.length - 1]
  if (last) {
    endWaiting = last.pool?.waitingCount ?? null
    endIdle = last.pool?.idleCount ?? null
  }

  return {
    concurrency,
    durationSec: Math.round((performance.now() - stageStart) / 1000),
    requests: results.length,
    success: ok,
    successPct: results.length ? Math.round((ok / results.length) * 1000) / 10 : 0,
    http4xx: err4,
    http5xx: err5,
    timeouts,
    p50: percentile(latencies, 50),
    p90: percentile(latencies, 90),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies.length ? latencies[latencies.length - 1] : 0,
    min: latencies.length ? latencies[0] : 0,
    peakWaiting,
    endWaiting,
    endIdle,
    peakPoolTotal,
    peakVerifyInFlight,
    peakPgActive,
    peakCpu,
    peakRam,
    aborted,
    abortReason,
    pass: !aborted && err5 === 0,
  }
}

async function cooldown(label) {
  console.log(`\n--- Cooldown ${COOLDOWN_SEC}s after ${label} ---`)
  const samples = []
  for (let i = 0; i < Math.ceil(COOLDOWN_SEC / 5); i++) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await fetchHealth()
    samples.push(h.pool?.waitingCount ?? 0)
    console.log(`  cooldown t+${(i + 1) * 5}s waitingCount=${h.pool?.waitingCount ?? '?'} idle=${h.pool?.idleCount ?? '?'}`)
  }
  return {
    recoveryWaiting: samples[samples.length - 1] ?? null,
    allZero: samples.every((w) => w === 0),
  }
}

async function main() {
  console.log(`Capacity regression → ${VPS}`)
  console.log(`Stages: ${STAGES.join(', ')} | ramp=${RAMP_SEC}s sustain=${STAGE_DURATION_SEC}s cooldown=${COOLDOWN_SEC}s`)
  console.log(`Paid probe device: ${PAID_DEVICE_ID}`)

  const baseline = await fetchHealthDb()
  const commit = (await fetchHealth()).commit
  console.log(`Live commit: ${commit}`)
  console.log(
    `Baseline pool: total=${baseline.pool?.totalCount} idle=${baseline.pool?.idleCount} waiting=${baseline.pool?.waitingCount}`,
  )
  console.log(
    `Baseline PG: max=${baseline.pg?.max_connections} active=${baseline.pg?.active_connections} states=${JSON.stringify(baseline.pg?.by_state || {})}`,
  )

  const stageResults = []
  let stoppedEarly = false

  for (const stage of STAGES) {
    if (stoppedEarly) break
    console.log(`\n========== STAGE ${stage} concurrent (sustained) ==========`)
    const pre = await fetchHealth()
    if ((pre.pool?.waitingCount ?? 0) > 10) {
      console.error(`ABORT: pre-stage pool already pressured waitingCount=${pre.pool.waitingCount}`)
      stoppedEarly = true
      break
    }

    const result = await runSustainedStage(stage)
    console.log(JSON.stringify(result, null, 2))
    const recovery = await cooldown(`stage ${stage}`)
    result.recoveryWaiting = recovery.recoveryWaiting
    result.recoveryAllZero = recovery.allZero
    result.pass = result.pass && recovery.recoveryWaiting === 0
    stageResults.push(result)

    if (result.aborted) {
      console.error(`ABORT at stage ${stage}: ${result.abortReason}`)
      stoppedEarly = true
    } else if (!result.pass) {
      console.error(`FAIL at stage ${stage}`)
      stoppedEarly = true
    }
  }

  const report = {
    commit,
    prefix: PREFIX,
    paidDeviceId: PAID_DEVICE_ID,
    stages: stageResults,
    stoppedEarly,
    timestampUtc: new Date().toISOString(),
  }
  console.log('\n========== CAPACITY REGRESSION REPORT JSON ==========')
  console.log(JSON.stringify(report, null, 2))

  const failed = stageResults.filter((r) => !r.pass)
  process.exit(failed.length || stoppedEarly ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
