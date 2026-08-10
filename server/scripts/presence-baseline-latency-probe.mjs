/**
 * Post-deploy presence latency probe against restored pre-telemetry UX.
 * Telemetry only — disposable device_id, no payment writes.
 *
 * Usage: node server/scripts/presence-baseline-latency-probe.mjs
 */
const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const DEVICE = `presence-baseline-probe-${Date.now()}`
const LOAD_DEVICES = Math.max(10, Math.min(80, Number(process.env.PRESENCE_LOAD_DEVICES) || 40))

async function post(path, body) {
  const res = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json }
}

async function getSnapshot() {
  const res = await fetch(`${API}/api/analytics/snapshot`, { headers: { Accept: 'application/json' } })
  return res.json().catch(() => ({}))
}

async function getHealth() {
  const res = await fetch(`${API}/api/health`, { headers: { Accept: 'application/json' } })
  return res.json().catch(() => ({}))
}

function viewers(snap, channelId) {
  const rows = Array.isArray(snap?.mostWatched) ? snap.mostWatched : []
  const hit = rows.find((r) => String(r.channel_id ?? r.id ?? '') === String(channelId))
  return Number(hit?.viewers ?? 0) || 0
}

function totals(snap) {
  return {
    online: Number(snap?.onlineNow) || 0,
    watching: Number(snap?.watchingNow) || 0,
    idle: Number(snap?.idleNow) || 0,
  }
}

async function waitFor(predicate, { timeoutMs = 8_000, pollMs = 150, label = 'condition' } = {}) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await getSnapshot()
    if (predicate(last)) return { ok: true, elapsedMs: Date.now() - t0, snap: last }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return { ok: false, elapsedMs: Date.now() - t0, snap: last, label }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const healthBefore = await getHealth()
const baseSnap = await getSnapshot()
const base = totals(baseSnap)
const baseA = viewers(baseSnap, '1')
const baseB = viewers(baseSnap, '11')
const chA = '1'
const chB = '11'

await post('/api/analytics/presence/heartbeat', { device_id: DEVICE, channel_id: null })
const onlineIdle = await waitFor((s) => {
  const t = totals(s)
  return t.online >= base.online + 1 && t.idle >= base.idle + 1
}, { label: 'online idle' })

const afterIdle = totals(onlineIdle.snap || {})

await post('/api/analytics/presence/heartbeat', {
  device_id: DEVICE,
  channel_id: chA,
  channel_name: 'Azam 1 HD',
})
const openDetect = await waitFor((s) => {
  const t = totals(s)
  return t.watching >= afterIdle.watching + 1 && viewers(s, chA) >= baseA + 1
}, { label: 'open A' })

const afterOpen = {
  totals: totals(openDetect.snap || {}),
  a: viewers(openDetect.snap || {}, chA),
}

await post('/api/analytics/presence/heartbeat', {
  device_id: DEVICE,
  channel_id: chB,
  channel_name: 'Azam TWO',
})
const switchDetect = await waitFor((s) => {
  return viewers(s, chA) <= Math.max(0, afterOpen.a - 1) && viewers(s, chB) >= baseB + 1
}, { label: 'switch A→B' })

const afterSwitch = {
  totals: totals(switchDetect.snap || {}),
  a: viewers(switchDetect.snap || {}, chA),
  b: viewers(switchDetect.snap || {}, chB),
}

await post('/api/analytics/presence/heartbeat', { device_id: DEVICE, channel_id: null })
const leaveDetect = await waitFor((s) => {
  const t = totals(s)
  return t.watching <= Math.max(0, afterSwitch.totals.watching - 1)
}, { label: 'leave idle' })

// Concurrent load: many disposable devices heartbeat once, then cleanup
const loadIds = Array.from({ length: LOAD_DEVICES }, (_, i) => `${DEVICE}-load-${i}`)
const loadHealthBefore = await getHealth()
await Promise.all(
  loadIds.map((id) =>
    post('/api/analytics/presence/heartbeat', {
      device_id: id,
      channel_id: chA,
      channel_name: 'Azam 1 HD',
    }),
  ),
)
await new Promise((r) => setTimeout(r, 800))
const loadHealthMid = await getHealth()
const loadSnap = await getSnapshot()
await Promise.all(loadIds.map((id) => post('/api/analytics/presence/stop', { device_id: id })))
await post('/api/analytics/presence/stop', { device_id: DEVICE })
await waitFor((s) => totals(s).online <= base.online + 2, {
  timeoutMs: 20_000,
  label: 'cleanup',
})

const healthAfter = await getHealth()
const finalSnap = await getSnapshot()
const final = totals(finalSnap)
const sumOk = final.online === final.watching + final.idle

const out = {
  device: DEVICE,
  commit: healthAfter?.commit,
  openMs: openDetect.ok ? openDetect.elapsedMs : null,
  switchMs: switchDetect.ok ? switchDetect.elapsedMs : null,
  leaveMs: leaveDetect.ok ? leaveDetect.elapsedMs : null,
  onlineIdleMs: onlineIdle.ok ? onlineIdle.elapsedMs : null,
  targetsMet: {
    openUnder2s: openDetect.ok && openDetect.elapsedMs <= 2000,
    switchUnder2s: switchDetect.ok && switchDetect.elapsedMs <= 2000,
    leaveUnder2s: leaveDetect.ok && leaveDetect.elapsedMs <= 2000,
  },
  switch: {
    watchingUnchanged: afterSwitch.totals.watching === afterOpen.totals.watching,
    channelA: afterSwitch.a,
    channelB: afterSwitch.b,
  },
  load: {
    devices: LOAD_DEVICES,
    poolWaitingMid: Number(loadHealthMid?.pool?.waitingCount) || 0,
    poolSaturatedMid: loadHealthMid?.pool?.saturated === true,
    watchingDuringLoad: totals(loadSnap).watching,
  },
  poolBefore: healthBefore?.pool,
  poolAfter: healthAfter?.pool,
  final: { ...final, sumOk, degraded: finalSnap?.degraded === true },
  paymentSmoke: null,
}

// Payment/subscription contract smoke (read-ish verify + checkout providers)
const verify = await fetch(`${API}/api/subscription/verify`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ device_id: `baseline-paycheck-${Date.now()}` }),
})
const verifyBody = await verify.json().catch(() => ({}))
const providers = await fetch(`${API}/api/payments/checkout-providers`).catch(() => null)
const providersStatus = providers ? providers.status : 0
out.paymentSmoke = {
  verifyStatus: verify.status,
  verifyHasActive: 'active' in verifyBody,
  providersStatus,
}

console.log(JSON.stringify(out, null, 2))

assert(openDetect.ok, 'open failed')
assert(switchDetect.ok, 'switch failed')
assert(leaveDetect.ok, 'leave failed')
assert(out.targetsMet.openUnder2s, `open too slow: ${out.openMs}ms`)
assert(out.targetsMet.switchUnder2s, `switch too slow: ${out.switchMs}ms`)
assert(out.targetsMet.leaveUnder2s, `leave too slow: ${out.leaveMs}ms`)
assert(sumOk, 'online != watching + idle')
assert(out.load.poolSaturatedMid !== true, 'pool saturated under load')
assert(out.load.poolWaitingMid === 0, `pool waiting under load: ${out.load.poolWaitingMid}`)
assert((Number(healthAfter?.pool?.waitingCount) || 0) === 0, 'pool waiting after')
assert(healthAfter?.pool?.saturated !== true, 'pool saturated after')
assert(verify.status === 200, 'subscription verify failed')
assert(out.paymentSmoke.verifyHasActive, 'verify contract missing active')

console.log('presence-baseline-latency-probe: PASS')
