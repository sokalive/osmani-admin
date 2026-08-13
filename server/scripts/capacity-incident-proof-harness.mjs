/**
 * Final production proof for the three match-time capacity failures:
 *
 *   A) Active viewer kicked Home (capacity-induced verify/auth failure)
 *   B) Paid package / subscription verification starved under presence load
 *   C) HTTP 500 / pool_saturated under kickoff + sustained match traffic
 *
 * Safe: disposable device_ids only. Does NOT create real payments, webhooks,
 * grants, SMS, or mutate entitlement. Payment path is exercised via
 * checkout-providers + plans + subscription verify (DB-capacity dependent).
 *
 * Usage:
 *   node server/scripts/capacity-incident-proof-harness.mjs
 *   STAGES=50,100,250,500 STAGE_DURATION_SEC=90 MATCH_DURATION_SEC=180 node ...
 */
const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const STAGES = (process.env.STAGES || '50,100,250,500,750,1000,1500,2000,2500,3000')
  .split(',')
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isFinite(n) && n > 0)
const STAGE_DURATION_SEC = Math.max(45, Math.min(300, Number(process.env.STAGE_DURATION_SEC) || 90))
const MATCH_DURATION_SEC = Math.max(90, Math.min(600, Number(process.env.MATCH_DURATION_SEC) || 180))
const COOLDOWN_SEC = Math.max(20, Math.min(120, Number(process.env.COOLDOWN_SEC) || 35))
const RAMP_SEC = Math.max(5, Math.min(90, Number(process.env.RAMP_SEC) || 15))
const PRESENCE_MS = Math.max(4000, Number(process.env.PRESENCE_MS) || 8000)
const KICKOFF_BATCH = Math.max(10, Math.min(80, Number(process.env.KICKOFF_BATCH) || 40))
const PAY_PROBE_STAGES = new Set(
  (process.env.PAY_PROBE_STAGES || '1000,1500,2000,2500,3000')
    .split(',')
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0),
)
const ABORT_WAITING = Math.max(30, Number(process.env.ABORT_WAITING_COUNT) || 80)
const PREFIX = `incproof_${Date.now()}`
const CHANNELS = ['1', '11', '18', '27']
const CANARY_COUNT = Math.max(3, Math.min(12, Number(process.env.CANARY_COUNT) || 6))

function percentile(sorted, p) {
  if (!sorted.length) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]
}

async function getJson(path, opts = {}) {
  const controller = new AbortController()
  const t = setTimeout(() => controller.abort(), Number(process.env.REQ_TIMEOUT_MS) || 20_000)
  try {
    const res = await fetch(`${API}${path}`, { cache: 'no-store', signal: controller.signal, ...opts })
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    return { status: res.status, json, text: text.slice(0, 220), timedOut: false }
  } catch (e) {
    const timedOut = /abort/i.test(String(e?.name || e?.message || e))
    return { status: 0, json: null, text: String(e?.message || e), timedOut: timedOut }
  } finally {
    clearTimeout(t)
  }
}

function isPoolSaturatedResponse(status, json) {
  const err = String(json?.error || '').toLowerCase()
  if (err === 'pool_saturated' || err === 'pool_acquire_timeout') return true
  if (status === 503 && (err.includes('pool_saturated') || err.includes('pool_acquire'))) return true
  if (status === 500 && (err.includes('pool_saturated') || err.includes('pool_acquire'))) return true
  return false
}

function classifyPoolErr(json) {
  const err = String(json?.error || '').toLowerCase()
  if (err.includes('pool_acquire_timeout')) return 'acquire_timeout'
  if (err.includes('pool_saturated')) return 'pool_saturated'
  return null
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
    status: h.status,
  }
}

async function presenceHeartbeat(deviceId, body) {
  const t0 = performance.now()
  const res = await getJson('/api/analytics/presence/heartbeat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, ...body }),
  })
  const poolKind = classifyPoolErr(res.json)
  return {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    poolErr: Boolean(poolKind),
    poolKind,
    timedOut: res.timedOut,
    ok: res.status >= 200 && res.status < 400 && !poolKind && !res.timedOut,
    label: 'presence',
    playbackAllowed: null,
  }
}

async function verify(deviceId) {
  const t0 = performance.now()
  const res = await getJson('/api/subscription/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, version_code: 24 }),
  })
  const poolKind = classifyPoolErr(res.json)
  const playbackAllowed = res.json?.playbackAllowed
  // Capacity-induced Home kick proxy: verify fails hard OR returns pool errors.
  const homeKickProxy =
    res.timedOut ||
    Boolean(poolKind) ||
    res.status === 500 ||
    (res.status === 503 && Boolean(poolKind))
  return {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    poolErr: Boolean(poolKind),
    poolKind,
    timedOut: res.timedOut,
    ok: res.status >= 200 && res.status < 400 && !poolKind && !res.timedOut,
    label: 'verify',
    playbackAllowed: playbackAllowed === undefined ? null : Boolean(playbackAllowed),
    homeKickProxy,
  }
}

async function checkoutProviders() {
  const t0 = performance.now()
  const res = await getJson('/api/payments/checkout-providers')
  const poolKind = classifyPoolErr(res.json)
  return {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    poolErr: Boolean(poolKind),
    poolKind,
    timedOut: res.timedOut,
    ok: res.status >= 200 && res.status < 400 && !poolKind && !res.timedOut,
    label: 'checkout',
    provider: res.json?.payment_provider || null,
  }
}

async function plans() {
  const t0 = performance.now()
  const res = await getJson('/api/plans')
  const poolKind = classifyPoolErr(res.json)
  return {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    poolErr: Boolean(poolKind),
    poolKind,
    timedOut: res.timedOut,
    ok: res.status >= 200 && res.status < 400 && !poolKind && !res.timedOut,
    label: 'plans',
  }
}

async function snapshot() {
  const t0 = performance.now()
  const res = await getJson('/api/analytics/snapshot')
  const poolKind = classifyPoolErr(res.json)
  return {
    status: res.status,
    latencyMs: Math.round(performance.now() - t0),
    poolErr: Boolean(poolKind),
    poolKind,
    timedOut: res.timedOut,
    ok: res.status >= 200 && res.status < 400 && !poolKind && !res.timedOut,
    label: 'snapshot',
  }
}

async function cleanupDevices(ids) {
  const chunk = 50
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

function emptyCounters() {
  return {
    requests: 0,
    success: 0,
    fail: 0,
    http500: 0,
    http503: 0,
    pool_saturated: 0,
    pool_acquire_timeout: 0,
    timedOut: 0,
    peakWaiting: 0,
    peakPoolTotal: 0,
    peakPgActive: 0,
    peakCpu: 0,
    peakRam: 0,
    latencies: [],
    criticalVerifyOk: 0,
    criticalVerifyFail: 0,
    criticalVerifyMs: [],
    checkoutOk: 0,
    checkoutFail: 0,
    plansOk: 0,
    plansFail: 0,
    homeKickProxy: 0,
    canaryVerifyOk: 0,
    canaryVerifyFail: 0,
  }
}

function absorb(c, r) {
  c.requests += 1
  c.latencies.push(r.latencyMs)
  if (r.ok) c.success += 1
  else c.fail += 1
  if (r.status === 500) c.http500 += 1
  if (r.status === 503) c.http503 += 1
  if (r.timedOut) c.timedOut += 1
  if (r.poolKind === 'pool_saturated') c.pool_saturated += 1
  if (r.poolKind === 'acquire_timeout') c.pool_acquire_timeout += 1
  if (r.homeKickProxy) c.homeKickProxy += 1
  if (r.label === 'verify') {
    if (r.ok) {
      c.criticalVerifyOk += 1
      c.criticalVerifyMs.push(r.latencyMs)
    } else c.criticalVerifyFail += 1
  }
  if (r.label === 'checkout') {
    if (r.ok) c.checkoutOk += 1
    else c.checkoutFail += 1
  }
  if (r.label === 'plans') {
    if (r.ok) c.plansOk += 1
    else c.plansFail += 1
  }
}

async function sampleHealthPeaks(c) {
  const h = await health()
  c.peakWaiting = Math.max(c.peakWaiting, Number(h.pool?.waitingCount) || 0)
  c.peakPoolTotal = Math.max(c.peakPoolTotal, Number(h.pool?.totalCount) || 0)
  c.peakPgActive = Math.max(c.peakPgActive, Number(h.pg?.active_connections) || 0)
  c.peakCpu = Math.max(c.peakCpu, Number(h.process?.cpu_load_pct_approx) || 0)
  c.peakRam = Math.max(c.peakRam, Number(h.process?.system_ram_used_pct) || 0)
  return h
}

async function kickoffBurst(devices, channelOf, c, batchSize = KICKOFF_BATCH) {
  for (let i = 0; i < devices.length; i += batchSize) {
    const slice = devices.slice(i, i + batchSize)
    const results = await Promise.all(
      slice.map((id, j) =>
        presenceHeartbeat(id, {
          channel_id: channelOf[i + j],
          channel_name: `ch-${channelOf[i + j]}`,
        }),
      ),
    )
    for (const r of results) absorb(c, r)
    const h = await sampleHealthPeaks(c)
    if (h.pool?.saturated === true || c.pool_saturated > 0 || c.http500 > 0) {
      return { aborted: true, reason: 'kickoff_saturation' }
    }
    if (c.peakWaiting >= ABORT_WAITING) {
      return { aborted: true, reason: `kickoff_waiting=${c.peakWaiting}` }
    }
    await new Promise((r) => setTimeout(r, 80))
  }
  return { aborted: false }
}

async function sustainedLoop({
  devices,
  channelOf,
  canaries,
  c,
  durationSec,
  concurrency,
  payProbe,
  label,
}) {
  const start = Date.now()
  const endAt = start + durationSec * 1000
  const rampEnd = start + RAMP_SEC * 1000
  let tick = 0
  let aborted = false
  let abortReason = null

  while (Date.now() < endAt && !aborted) {
    const now = Date.now()
    const activeN =
      now < rampEnd
        ? Math.max(1, Math.ceil(concurrency * ((now - start) / (RAMP_SEC * 1000))))
        : concurrency

    const perTick = Math.max(1, Math.ceil((activeN * 400) / PRESENCE_MS))
    const offset = (tick * perTick) % activeN
    const batch = []

    for (let k = 0; k < perTick; k += 1) {
      const i = (offset + k) % activeN
      const id = devices[i]
      const roll = (tick + i) % 12
      if (roll === 0) {
        batch.push(presenceHeartbeat(id, { channel_id: null }))
      } else if (roll === 1) {
        const ch = CHANNELS[(i + tick) % CHANNELS.length]
        channelOf[i] = ch
        batch.push(presenceHeartbeat(id, { channel_id: ch, channel_name: `ch-${ch}` }))
      } else if (roll === 2) {
        batch.push(verify(id))
      } else {
        batch.push(
          presenceHeartbeat(id, {
            channel_id: channelOf[i],
            channel_name: `ch-${channelOf[i]}`,
          }),
        )
      }
    }

    // Canary viewers: sustained watching + periodic verify (Home-kick detector)
    for (const canary of canaries) {
      if (tick % 3 === 0) {
        batch.push(
          presenceHeartbeat(canary.id, {
            channel_id: canary.channelId,
            channel_name: `canary-${canary.channelId}`,
          }),
        )
      }
      if (tick % 5 === 0) {
        batch.push(
          verify(canary.id).then((r) => {
            if (r.ok) c.canaryVerifyOk += 1
            else c.canaryVerifyFail += 1
            return r
          }),
        )
      }
    }

    if (tick % 2 === 0) batch.push(snapshot())

    if (payProbe && tick % 4 === 0) {
      batch.push(checkoutProviders())
      batch.push(plans())
      // Dedicated payment-path verify devices (not load devices)
      batch.push(verify(`${PREFIX}_pay_${concurrency}_${tick}`))
    }

    // Halftime/kickoff-style micro-burst every ~25 ticks
    if (tick > 0 && tick % 25 === 0) {
      const burstN = Math.min(activeN, Math.max(30, Math.floor(activeN * 0.08)))
      for (let b = 0; b < burstN; b += 1) {
        const i = (offset + b * 7) % activeN
        const ch = CHANNELS[(i + tick) % CHANNELS.length]
        channelOf[i] = ch
        batch.push(presenceHeartbeat(devices[i], { channel_id: ch, channel_name: `burst-${ch}` }))
      }
    }

    const results = await Promise.all(batch)
    for (const r of results) absorb(c, r)
    const h = await sampleHealthPeaks(c)

    if ((Number(h.pool?.waitingCount) || 0) >= ABORT_WAITING) {
      aborted = true
      abortReason = `waitingCount=${h.pool.waitingCount}`
    }
    if (h.pool?.saturated === true) {
      aborted = true
      abortReason = 'pool.saturated=true'
    }
    if (c.pool_saturated > 0 || c.pool_acquire_timeout > 0) {
      aborted = true
      abortReason = 'pool_capacity_error'
    }
    if (c.http500 > 0) {
      aborted = true
      abortReason = `http500=${c.http500}`
    }
    if (c.homeKickProxy > 0) {
      aborted = true
      abortReason = `home_kick_proxy=${c.homeKickProxy}`
    }
    if (c.canaryVerifyFail > 0) {
      aborted = true
      abortReason = `canary_verify_fail=${c.canaryVerifyFail}`
    }
    if (payProbe && (c.checkoutFail > 0 || c.plansFail > 0 || c.criticalVerifyFail > 2)) {
      aborted = true
      abortReason = `payment_path_fail checkout=${c.checkoutFail} plans=${c.plansFail} verifyFail=${c.criticalVerifyFail}`
    }
    if (c.requests > 80 && c.fail / c.requests > 0.05) {
      aborted = true
      abortReason = `fail_rate=${(c.fail / c.requests).toFixed(3)}`
    }

    tick += 1
    await new Promise((r) => setTimeout(r, 400))
  }

  return { aborted, abortReason, label, ticks: tick }
}

function summarize(c, extra = {}) {
  const sorted = [...c.latencies].sort((a, b) => a - b)
  const verifySorted = [...c.criticalVerifyMs].sort((a, b) => a - b)
  return {
    ...extra,
    requests: c.requests,
    success: c.success,
    fail: c.fail,
    successPct: c.requests ? Math.round((1000 * c.success) / c.requests) / 10 : 0,
    http500: c.http500,
    http503: c.http503,
    pool_saturated: c.pool_saturated,
    pool_acquire_timeout: c.pool_acquire_timeout,
    timedOut: c.timedOut,
    peakWaiting: c.peakWaiting,
    peakPoolTotal: c.peakPoolTotal,
    peakPgActive: c.peakPgActive,
    peakCpu: c.peakCpu,
    peakRam: c.peakRam,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    homeKickProxy: c.homeKickProxy,
    canaryVerifyOk: c.canaryVerifyOk,
    canaryVerifyFail: c.canaryVerifyFail,
    criticalVerifyOk: c.criticalVerifyOk,
    criticalVerifyFail: c.criticalVerifyFail,
    criticalVerifyP95: percentile(verifySorted, 95),
    checkoutOk: c.checkoutOk,
    checkoutFail: c.checkoutFail,
    plansOk: c.plansOk,
    plansFail: c.plansFail,
  }
}

async function runStage(concurrency, { durationSec, payProbe, isMatch }) {
  const devices = Array.from({ length: concurrency }, (_, i) => `${PREFIX}_${concurrency}_${i}`)
  const channelOf = devices.map((_, i) => CHANNELS[i % CHANNELS.length])
  const canaries = Array.from({ length: CANARY_COUNT }, (_, i) => ({
    id: `${PREFIX}_canary_${concurrency}_${i}`,
    channelId: CHANNELS[i % CHANNELS.length],
  }))
  const c = emptyCounters()
  const start = Date.now()

  // Seed canaries as active watchers before kickoff.
  for (const canary of canaries) {
    const r = await presenceHeartbeat(canary.id, {
      channel_id: canary.channelId,
      channel_name: `canary-${canary.channelId}`,
    })
    absorb(c, r)
  }

  const kick = await kickoffBurst(devices, channelOf, c)
  if (kick.aborted) {
    await cleanupDevices([...devices, ...canaries.map((x) => x.id)])
    const out = summarize(c, {
      concurrency,
      durationSec: Math.round((Date.now() - start) / 1000),
      aborted: true,
      abortReason: kick.reason,
      payProbe,
      isMatch,
    })
    out.pass = false
    return out
  }

  const loop = await sustainedLoop({
    devices,
    channelOf,
    canaries,
    c,
    durationSec,
    concurrency,
    payProbe,
    label: isMatch ? 'match' : 'stage',
  })

  await cleanupDevices([...devices, ...canaries.map((x) => x.id)])

  const out = summarize(c, {
    concurrency,
    durationSec: Math.round((Date.now() - start) / 1000),
    aborted: loop.aborted,
    abortReason: loop.abortReason,
    payProbe,
    isMatch,
    ticks: loop.ticks,
  })

  out.incidentA_viewerHome = out.homeKickProxy === 0 && out.canaryVerifyFail === 0
  out.incidentB_paymentStarved =
    !payProbe ||
    (out.checkoutFail === 0 && out.plansFail === 0 && out.criticalVerifyFail === 0)
  out.incidentC_poolSaturated =
    out.pool_saturated === 0 && out.pool_acquire_timeout === 0 && out.http500 === 0

  out.pass =
    !out.aborted &&
    out.incidentA_viewerHome &&
    out.incidentB_paymentStarved &&
    out.incidentC_poolSaturated &&
    out.peakWaiting < ABORT_WAITING &&
    out.fail / Math.max(1, out.requests) <= 0.05

  return out
}

async function cooldown() {
  for (let i = 0; i < Math.ceil(COOLDOWN_SEC / 5); i += 1) {
    await new Promise((r) => setTimeout(r, 5000))
    const h = await health()
    console.log(
      `  cooldown t+${(i + 1) * 5}s waiting=${h.pool?.waitingCount} idle=${h.pool?.idleCount} sat=${h.pool?.saturated} max=${h.pool?.max}`,
    )
  }
}

async function paymentSmoke() {
  const results = []
  for (let i = 0; i < 4; i += 1) {
    const d = `${PREFIX}_smoke_${i}`
    const v = await verify(d)
    const c = await checkoutProviders()
    const p = await plans()
    results.push({
      i,
      verify: v.status,
      verifyMs: v.latencyMs,
      checkout: c.status,
      provider: c.provider,
      plans: p.status,
      ok: v.ok && c.ok && p.ok,
    })
  }
  return results
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
      matchDurationSec: MATCH_DURATION_SEC,
      presenceMs: PRESENCE_MS,
      payProbeStages: [...PAY_PROBE_STAGES],
    },
    null,
    2,
  ),
)

const prePay = await paymentSmoke()
console.log('PRE_PAYMENT_SMOKE', JSON.stringify(prePay))
if (prePay.some((r) => !r.ok)) {
  console.error('ABORT: payment/subscription smoke failed before load')
  process.exitCode = 1
  process.exit(1)
}

const results = []
for (const n of STAGES) {
  console.log(`\n========== STAGE ${n} concurrent (${STAGE_DURATION_SEC}s) ==========`)
  const pre = await health()
  if ((Number(pre.pool?.waitingCount) || 0) > 10 || pre.pool?.saturated === true) {
    console.error('ABORT: pool already pressured before stage', pre.pool)
    results.push({ concurrency: n, pass: false, abortReason: 'pre_stage_pressure' })
    break
  }
  const out = await runStage(n, {
    durationSec: STAGE_DURATION_SEC,
    payProbe: PAY_PROBE_STAGES.has(n),
    isMatch: false,
  })
  results.push(out)
  console.log(JSON.stringify(out, null, 2))
  if (!out.pass) {
    console.error(`FAIL at ${n}: ${out.abortReason || 'criteria'}`)
    break
  }
  console.log(`--- cooldown ${COOLDOWN_SEC}s ---`)
  await cooldown()
}

let matchResult = null
const allStagesPass = results.length === STAGES.length && results.every((r) => r.pass)
if (allStagesPass) {
  console.log(`\n========== MATCH SIMULATION 3000 (${MATCH_DURATION_SEC}s) ==========`)
  matchResult = await runStage(3000, {
    durationSec: MATCH_DURATION_SEC,
    payProbe: true,
    isMatch: true,
  })
  console.log(JSON.stringify(matchResult, null, 2))
}

const postPay = await paymentSmoke()
console.log('POST_PAYMENT_SMOKE', JSON.stringify(postPay))

const summary = {
  commit: baseline.commit,
  poolMaxObserved: baseline.pool?.max,
  allStagesPass,
  matchPass: Boolean(matchResult?.pass),
  highestProvenConcurrency: results.filter((r) => r.pass).reduce((m, r) => Math.max(m, r.concurrency), 0),
  incidentA_viewerHome: results.every((r) => r.incidentA_viewerHome !== false) && matchResult?.incidentA_viewerHome !== false,
  incidentB_paymentStarved:
    results.every((r) => r.incidentB_paymentStarved !== false) && matchResult?.incidentB_paymentStarved !== false,
  incidentC_poolSaturated:
    results.every((r) => r.incidentC_poolSaturated !== false) && matchResult?.incidentC_poolSaturated !== false,
  postPaymentOk: postPay.every((r) => r.ok),
  results,
  matchResult,
}

const finalPass =
  summary.allStagesPass &&
  summary.matchPass &&
  summary.incidentA_viewerHome &&
  summary.incidentB_paymentStarved &&
  summary.incidentC_poolSaturated &&
  summary.postPaymentOk

console.log('\n===== INCIDENT PROOF SUMMARY =====')
console.log(JSON.stringify({ ...summary, finalPass }, null, 2))
if (!finalPass) process.exitCode = 1
else console.log('capacity-incident-proof-harness: PASS')
