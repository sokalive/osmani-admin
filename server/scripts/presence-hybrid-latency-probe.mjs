/**
 * Controlled production presence latency probe (telemetry only).
 * Uses a disposable device_id; no payment/subscription business mutations.
 *
 * Usage: node server/scripts/presence-hybrid-latency-probe.mjs
 */
const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const DEVICE = `presence-hybrid-probe-${Date.now()}`

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
  const json = await res.json().catch(() => ({}))
  return { status: res.status, json, at: Date.now() }
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

async function waitFor(predicate, { timeoutMs = 8_000, pollMs = 200, label = 'condition' } = {}) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < timeoutMs) {
    last = await getSnapshot()
    if (predicate(last.json)) {
      return { ok: true, elapsedMs: Date.now() - t0, snap: last.json }
    }
    await new Promise((r) => setTimeout(r, pollMs))
  }
  return { ok: false, elapsedMs: Date.now() - t0, snap: last?.json || null, label }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const healthBefore = await getHealth()
const baseSnap = (await getSnapshot()).json
const base = totals(baseSnap)
const baseA = viewers(baseSnap, '1')
const baseB = viewers(baseSnap, '11')

const chA = '1'
const chB = '11'

// Bring device online idle
await post('/api/analytics/presence/heartbeat', {
  device_id: DEVICE,
  channel_id: null,
})
const onlineIdle = await waitFor((s) => {
  const t = totals(s)
  return t.online >= base.online + 1 && t.idle >= base.idle + 1
}, { timeoutMs: 10_000, label: 'online idle' })

const afterIdle = totals(onlineIdle.snap || {})

// Open channel A: idle→watching
await post('/api/analytics/presence/heartbeat', {
  device_id: DEVICE,
  channel_id: chA,
  channel_name: 'Azam 1 HD',
})
const openDetect = await waitFor((s) => {
  const t = totals(s)
  const a = viewers(s, chA)
  return t.watching >= afterIdle.watching + 1 && a >= baseA + 1
}, { timeoutMs: 8_000, label: 'open A' })

const afterOpen = {
  totals: totals(openDetect.snap || {}),
  a: viewers(openDetect.snap || {}, chA),
  b: viewers(openDetect.snap || {}, chB),
}

// Ordinary same-state heartbeats should keep watching stable
const hb = []
for (let i = 0; i < 6; i += 1) {
  await post('/api/analytics/presence/heartbeat', {
    device_id: DEVICE,
    channel_id: chA,
    channel_name: 'Azam 1 HD',
  })
  const s = (await getSnapshot()).json
  hb.push(totals(s).watching)
  await new Promise((r) => setTimeout(r, 150))
}
const ordinaryHeartbeatsStable = hb.every((w) => w === afterOpen.totals.watching)

// Switch A → B (watching count stays; viewer moves channels)
await post('/api/analytics/presence/heartbeat', {
  device_id: DEVICE,
  channel_id: chB,
  channel_name: 'Azam TWO',
})
const switchDetect = await waitFor((s) => {
  const a = viewers(s, chA)
  const b = viewers(s, chB)
  return a <= Math.max(0, afterOpen.a - 1) && b >= baseB + 1
}, { timeoutMs: 8_000, label: 'switch A→B' })

const afterSwitch = {
  totals: totals(switchDetect.snap || {}),
  a: viewers(switchDetect.snap || {}, chA),
  b: viewers(switchDetect.snap || {}, chB),
}

// Leave B → idle
await post('/api/analytics/presence/heartbeat', {
  device_id: DEVICE,
  channel_id: null,
})
const leaveDetect = await waitFor((s) => {
  const t = totals(s)
  const b = viewers(s, chB)
  return t.watching <= Math.max(0, afterSwitch.totals.watching - 1) && b <= Math.max(0, afterSwitch.b - 1)
}, { timeoutMs: 8_000, label: 'leave to idle' })

// Cleanup offline
await post('/api/analytics/presence/stop', { device_id: DEVICE })
await waitFor((s) => totals(s).online <= base.online, {
  timeoutMs: 15_000,
  label: 'offline cleanup',
})

const healthAfter = await getHealth()
const finalSnap = (await getSnapshot()).json
const final = totals(finalSnap)
const sumOk = final.online === final.watching + final.idle

const out = {
  device: DEVICE,
  commit: healthAfter?.commit,
  baseline: base,
  open: { ok: openDetect.ok, lagMs: openDetect.ok ? openDetect.elapsedMs : null },
  switch: {
    ok: switchDetect.ok,
    lagMs: switchDetect.ok ? switchDetect.elapsedMs : null,
    channelA: afterSwitch.a,
    channelB: afterSwitch.b,
    watchingUnchanged:
      afterSwitch.totals.watching === afterOpen.totals.watching,
  },
  leave: { ok: leaveDetect.ok, lagMs: leaveDetect.ok ? leaveDetect.elapsedMs : null },
  onlineIdleAppearMs: onlineIdle.ok ? onlineIdle.elapsedMs : null,
  ordinaryHeartbeatsStable,
  heartbeatWatchingSamples: hb,
  poolAfter: healthAfter?.pool,
  poolSaturated: healthAfter?.pool?.saturated === true,
  poolWaiting: Number(healthAfter?.pool?.waitingCount) || 0,
  final: { ...final, sumOk, degraded: finalSnap?.degraded === true },
  targetsMet: {
    openUnder2s: openDetect.ok && openDetect.elapsedMs <= 2000,
    leaveUnder2s: leaveDetect.ok && leaveDetect.elapsedMs <= 2000,
    switchUnder2s: switchDetect.ok && switchDetect.elapsedMs <= 2000,
  },
}

console.log(JSON.stringify(out, null, 2))

assert(String(out.commit || '').includes('2c46d44'), `expected commit 2c46d44, got ${out.commit}`)
assert(openDetect.ok, 'open channel not detected quickly')
assert(switchDetect.ok, 'channel switch not detected quickly')
assert(leaveDetect.ok, 'leave channel not detected quickly')
assert(ordinaryHeartbeatsStable, 'ordinary heartbeats changed watching count')
assert(sumOk, 'final online != watching + idle')
assert(!out.poolSaturated, 'pool saturated')
assert(out.poolWaiting === 0, `pool waiting=${out.poolWaiting}`)

console.log('presence-hybrid-latency-probe: PASS')
