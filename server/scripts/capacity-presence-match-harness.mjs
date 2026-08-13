/**
 * Realistic match-peak capacity harness.
 *
 * Each virtual user:
 * - presence UPSERT ~every PRESENCE_MS (default 8s) like subscription-stream
 * - occasional channel open/switch/leave
 * - occasional subscription verify
 * Shared Admin snapshot poller (not per-user).
 *
 * Safe: disposable device_ids; no payment create/webhook/grant/SMS.
 *
 * Usage:
 *   node server/scripts/capacity-presence-match-harness.mjs
 *   STAGES=50,100,250,500 STAGE_DURATION_SEC=45 node server/scripts/capacity-presence-match-harness.mjs
 */
const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const STAGES = (process.env.STAGES || '50,100,250,500,750,1000,1500,2000,2500,3000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
const STAGE_DURATION_SEC = Math.max(20, Math.min(180, Number(process.env.STAGE_DURATION_SEC) || 45))
const COOLDOWN_SEC = Math.max(15, Math.min(120, Number(process.env.COOLDOWN_SEC) || 30))
const RAMP_SEC = Math.max(3, Math.min(60, Number(process.env.RAMP_SEC) || 12))
const PRESENCE_MS = Math.max(3000, Number(process.env.PRESENCE_MS) || 8000)
const VERIFY_EVERY_N = Math.max(2, Number(process.env.VERIFY_EVERY_N) || 5)
const ABORT_WAITING = Math.max(20, Number(process.env.ABORT_WAITING_COUNT) || 40)
const PREFIX = `capmatch_${Date.now()}`
const CHANNELS = ['1', '11', '18', '27']

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]
}

async function getJson(path, opts = {}) {
  const res = await fetch(`${API}${path}`, { cache: 'no-store', ...opts })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, json, text: text.slice(0, 220) }
}

function isPoolSaturatedResponse(status, json) {
  const err = String(json?.error || '').toLowerCase()
  if (err === 'pool_saturated' || err === 'pool_acquire_timeout') return true
  if (status === 503 && err.includes('pool_saturated')) return true
  if (status === 500 && err.includes('pool_saturated')) return true
  return false
}

async function health() {
  const h = await getJson('/api/health')
  const db = await getJson('/api/health/db')
  return {
    commit: h.json?.commit,
    pool: h.json?.pool || {},
    verify_db: h.json?.verify_db || {},
    pg: db.json?.pg || {},
    process: db.json?.process || {},
  }
}

async function presenceHeartbeat(deviceId, body) {
  const t0 = performance.now()
  const res = await getJson('/api/analytics/presence/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, ...body }),
  })
  return {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    poolErr: isPoolSaturatedResponse(res.status, res.json),
    ok: res.status >= 200 && res.status < 400 && !isPoolSaturatedResponse(res.status, res.json),
    label: 'presence',
  }
}

async function verify(deviceId) {
  const t0 = performance.now()
  const res = await getJson('/api/subscription/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, version_code: 24 }),
  })
  return {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    poolErr: isPoolSaturatedResponse(res.status, res.json),
    ok: res.status >= 200 && res.status < 400 && !isPoolSaturatedResponse(res.status, res.json),
    label: 'verify',
  }
}

async function snapshot() {
  const t0 = performance.now()
  const res = await getJson('/api/analytics/snapshot')
  return {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    poolErr: isPoolSaturatedResponse(res.status, res.json),
    ok: res.status >= 200 && res.status < 400 && !isPoolSaturatedResponse(res.status, res.json),
    label: 'snapshot',
  }
}

async function cleanupDevices(ids) {
  const chunk = 40
  for (let i = 0; i < ids.length; i += chunk) {
    await Promise.allSettled(
      ids.slice(i, i + chunk).map((id) =>
        getJson('/api/analytics/presence/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: id }),
        }),
      ),
    )
  }
}

async function runStage(concurrency) {
  const devices = Array.from({ length: concurrency }, (_, i) => `${PREFIX}_${concurrency}_${i}`)
  const channelOf = devices.map((_, i) => CHANNELS[i % CHANNELS.length])
  const latencies = []
  let success = 0
  let fail = 0
  let http500 = 0
  let http503 = 0
  let poolSaturated = 0
  let poolAcquireTimeout = 0
  let peakWaiting = 0
  let peakTotal = 0
  let peakPgActive = 0
  let peakCpu = 0
  let peakRam = 0
  let aborted = false
  let abortReason = null
  let requests = 0
  let tick = 0

  const start = Date.now()
  const endAt = start + STAGE_DURATION_SEC * 1000
  const rampEnd = start + RAMP_SEC * 1000

  // Bring users online watching a channel (kickoff burst, paced).
  for (let i = 0; i < concurrency && !aborted; i += 20) {
    const slice = devices.slice(i, i + 20)
    const results = await Promise.all(
      slice.map((id, j) =>
        presenceHeartbeat(id, {
          channel_id: channelOf[i + j],
          channel_name: `ch-${channelOf[i + j]}`,
        }),
      ),
    )
    for (const r of results) {
      requests += 1
      latencies.push(r.latencyMs)
      if (r.ok) success += 1
      else fail += 1
      if (r.status === 500) http500 += 1
      if (r.status === 503) http503 += 1
      if (r.poolErr) poolSaturated += 1
    }
    const h = await health()
    peakWaiting = Math.max(peakWaiting, Number(h.pool?.waitingCount) || 0)
    peakTotal = Math.max(peakTotal, Number(h.pool?.totalCount) || 0)
    peakPgActive = Math.max(peakPgActive, Number(h.pg?.active_connections) || 0)
    if (h.pool?.saturated === true || poolSaturated > 0 || peakWaiting >= ABORT_WAITING) {
      aborted = true
      abortReason = h.pool?.saturated ? 'pool.saturated' : `waiting/pool_err`
      break
    }
    await new Promise((r) => setTimeout(r, 150))
  }

  while (Date.now() < endAt && !aborted) {
    const now = Date.now()
    const activeN =
      now < rampEnd
        ? Math.max(1, Math.ceil(concurrency * ((now - start) / (RAMP_SEC * 1000))))
        : concurrency

    // Stagger presence: each tick only ~activeN * (400/PRESENCE_MS) users refresh.
    const perTick = Math.max(1, Math.ceil((activeN * 400) / PRESENCE_MS))
    const offset = (tick * perTick) % activeN
    const batch = []
    for (let k = 0; k < perTick; k += 1) {
      const i = (offset + k) % activeN
      const id = devices[i]
      const roll = (tick + i) % 10
      if (roll === 0) {
        // leave
        batch.push(presenceHeartbeat(id, { channel_id: null }))
      } else if (roll === 1) {
        // switch
        const ch = CHANNELS[(i + tick) % CHANNELS.length]
        channelOf[i] = ch
        batch.push(presenceHeartbeat(id, { channel_id: ch, channel_name: `ch-${ch}` }))
      } else if (roll % VERIFY_EVERY_N === 0) {
        batch.push(verify(id))
      } else {
        // ordinary same-state heartbeat
        batch.push(
          presenceHeartbeat(id, {
            channel_id: channelOf[i],
            channel_name: `ch-${channelOf[i]}`,
          }),
        )
      }
    }
    // One Admin snapshot every other tick (shared, not O(users))
    if (tick % 2 === 0) batch.push(snapshot())

    const results = await Promise.all(batch)
    for (const r of results) {
      requests += 1
      latencies.push(r.latencyMs)
      if (r.ok) success += 1
      else fail += 1
      if (r.status === 500) http500 += 1
      if (r.status === 503) http503 += 1
      if (r.poolErr) {
        poolSaturated += 1
        const err = String(r.status)
        if (err) poolAcquireTimeout += 0
      }
    }

    const h = await health()
    peakWaiting = Math.max(peakWaiting, Number(h.pool?.waitingCount) || 0)
    peakTotal = Math.max(peakTotal, Number(h.pool?.totalCount) || 0)
    peakPgActive = Math.max(peakPgActive, Number(h.pg?.active_connections) || 0)
    peakCpu = Math.max(peakCpu, Number(h.process?.cpu_load_pct_approx) || 0)
    peakRam = Math.max(peakRam, Number(h.process?.system_ram_used_pct) || 0)

    if ((Number(h.pool?.waitingCount) || 0) >= ABORT_WAITING) {
      aborted = true
      abortReason = `waitingCount=${h.pool.waitingCount}`
    }
    if (h.pool?.saturated === true) {
      aborted = true
      abortReason = 'pool.saturated=true'
    }
    if (poolSaturated > 0) {
      aborted = true
      abortReason = 'pool_saturated_in_response'
    }
    if (http500 > 0) {
      aborted = true
      abortReason = `http500=${http500}`
    }
    if (requests > 40 && fail / requests > 0.05) {
      aborted = true
      abortReason = `fail_rate=${(fail / requests).toFixed(3)}`
    }

    tick += 1
    await new Promise((r) => setTimeout(r, 400))
  }

  await cleanupDevices(devices)
  const sorted = [...latencies].sort((a, b) => a - b)
  const pass =
    !aborted &&
    poolSaturated === 0 &&
    http500 === 0 &&
    peakWaiting < ABORT_WAITING &&
    fail / Math.max(1, requests) <= 0.05

  return {
    concurrency,
    durationSec: Math.round((Date.now() - start) / 1000),
    requests,
    success,
    fail,
    successPct: requests ? Math.round((1000 * success) / requests) / 10 : 0,
    http500,
    http503,
    pool_saturated: poolSaturated,
    pool_acquire_timeout: poolAcquireTimeout,
    peakWaiting,
    peakPoolTotal: peakTotal,
    peakPgActive,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    peakCpu,
    peakRam,
    aborted,
    abortReason,
    pass,
  }
}

async function cooldown() {
  for (let i = 0; i < Math.ceil(COOLDOWN_SEC / 5); i += 1) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await health()
    console.log(
      `  cooldown t+${(i + 1) * 5}s waiting=${h.pool?.waitingCount} idle=${h.pool?.idleCount} sat=${h.pool?.saturated}`,
    )
  }
}

const baseline = await health()
console.log(
  JSON.stringify(
    {
      api: API,
      commit: baseline.commit,
      baselinePool: baseline.pool,
      stages: STAGES,
      stageDurationSec: STAGE_DURATION_SEC,
      presenceMs: PRESENCE_MS,
    },
    null,
    2,
  ),
)

const results = []
for (const n of STAGES) {
  console.log(`\n========== STAGE ${n} concurrent ==========`)
  const pre = await health()
  if ((Number(pre.pool?.waitingCount) || 0) > 10 || pre.pool?.saturated === true) {
    console.error('ABORT: pool already pressured before stage', pre.pool)
    results.push({ concurrency: n, pass: false, abortReason: 'pre_stage_pressure' })
    break
  }
  const out = await runStage(n)
  results.push(out)
  console.log(JSON.stringify(out, null, 2))
  if (!out.pass) {
    console.error(`FAIL at ${n}: ${out.abortReason || 'criteria'}`)
    break
  }
  console.log(`--- cooldown ${COOLDOWN_SEC}s ---`)
  await cooldown()
}

const proven = results.filter((r) => r.pass).map((r) => r.concurrency)
const highestProven = proven.length ? Math.max(...proven) : 0
const summary = {
  commit: baseline.commit,
  highestProvenConcurrency: highestProven,
  allPassed: results.length === STAGES.length && results.every((r) => r.pass),
  results,
}
console.log('\n===== SUMMARY =====')
console.log(JSON.stringify(summary, null, 2))
if (!summary.allPassed) process.exitCode = 1
else console.log('capacity-presence-match-harness: PASS')
