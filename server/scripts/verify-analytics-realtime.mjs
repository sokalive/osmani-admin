/**
 * Realtime presence latency verification (production-safe synthetic devices).
 *
 * Usage:
 *   node scripts/verify-analytics-realtime.mjs
 *   VPS_API=https://api.osmanitv.com node scripts/verify-analytics-realtime.mjs
 */
const BASE = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const PREFIX = `rt_${Date.now()}_`
const CHANNEL_ID = String(process.env.RT_TEST_CHANNEL_ID || '88')
const MAX_APPEAR_MS = Number(process.env.RT_MAX_APPEAR_MS || 2500)
const MAX_VANISH_MS = Number(process.env.RT_MAX_VANISH_MS || 3500)

let failed = 0
const evidence = { steps: [] }

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function pass(msg) {
  console.log(`OK ${msg}`)
}

function record(step, data) {
  evidence.steps.push({ step, at: new Date().toISOString(), ...data })
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, ok: res.ok }
}

async function snapshot() {
  const { body } = await fetchJson(`${BASE}/api/analytics/snapshot`)
  return body
}

function channelViewers(snap, channelId) {
  const rows = Array.isArray(snap?.mostWatched) ? snap.mostWatched : []
  const row = rows.find((r) => String(r.channel_id) === String(channelId))
  return Number(row?.viewers) || 0
}

function deviceOnline(snap, deviceId) {
  const online = Number(snap?.onlineNow) || 0
  const watching = Number(snap?.watchingNow) || 0
  return { online, watching, windowSec: snap?.livePresenceWindowSeconds ?? null }
}

async function heartbeat(deviceId, payload = {}) {
  return fetchJson(`${BASE}/api/analytics/session/heartbeat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId, ...payload }),
  })
}

async function sessionEnd(deviceId) {
  return fetchJson(`${BASE}/api/analytics/session/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  })
}

async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 150, label = 'condition' } = {}) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    const snap = await snapshot()
    if (predicate(snap)) return { ms: Date.now() - t0, snap }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return { ms: null, snap: await snapshot() }
}

async function main() {
  const deviceA = `${PREFIX}a`
  const deviceB = `${PREFIX}b`

  const before = await snapshot()
  record('before', {
    livePresenceWindowSeconds: before?.livePresenceWindowSeconds,
    sessionPruneSeconds: before?.sessionPruneSeconds,
    onlineNow: before?.onlineNow,
  })
  console.log('Config:', {
    livePresenceWindowSeconds: before?.livePresenceWindowSeconds,
    sessionPruneSeconds: before?.sessionPruneSeconds,
  })

  const baseViewers = channelViewers(before, CHANNEL_ID)

  const hb = await heartbeat(deviceA, {
    channel_id: CHANNEL_ID,
    country_code: 'TZ',
    city: 'Dar es Salaam',
  })
  if (hb.status !== 200 || hb.body?.ok !== true) fail(`heartbeat start HTTP ${hb.status}`)
  else pass('session heartbeat accepted')

  const appear = await waitFor(
    (snap) => channelViewers(snap, CHANNEL_ID) >= baseViewers + 1,
    { timeoutMs: MAX_APPEAR_MS + 1500, label: 'channel appear' },
  )
  if (appear.ms == null) {
    fail(`channel ${CHANNEL_ID} viewer did not increase within ${MAX_APPEAR_MS + 1500}ms`)
  } else if (appear.ms > MAX_APPEAR_MS) {
    fail(`channel appear took ${appear.ms}ms (max ${MAX_APPEAR_MS})`)
  } else {
    pass(`channel appear in ${appear.ms}ms`)
  }
  record('channel_appear_ms', { ms: appear.ms, channelId: CHANNEL_ID })

  const idleHb = await heartbeat(deviceB, { country_code: 'KE', city: 'Nairobi' })
  if (idleHb.status !== 200) fail(`idle heartbeat HTTP ${idleHb.status}`)
  const beforeOnline = Number(before?.onlineNow) || 0
  const idleAppear = await waitFor(
    (snap) => (Number(snap?.onlineNow) || 0) >= beforeOnline + 1,
    { timeoutMs: MAX_APPEAR_MS + 1500, label: 'idle online' },
  )
  if (idleAppear.ms == null) fail('idle user did not appear online')
  else if (idleAppear.ms > MAX_APPEAR_MS) fail(`idle appear took ${idleAppear.ms}ms`)
  else pass(`idle user online in ${idleAppear.ms}ms`)
  record('idle_appear_ms', { ms: idleAppear.ms })

  await sessionEnd(deviceA)
  const vanishA = await waitFor(
    (snap) => channelViewers(snap, CHANNEL_ID) <= baseViewers,
    { timeoutMs: MAX_VANISH_MS + 1500, label: 'channel vanish' },
  )
  if (vanishA.ms == null) fail('channel viewer did not decrease after session/end')
  else if (vanishA.ms > MAX_VANISH_MS) fail(`channel vanish took ${vanishA.ms}ms`)
  else pass(`channel vanish in ${vanishA.ms}ms`)
  record('channel_vanish_ms', { ms: vanishA.ms })

  await sessionEnd(deviceB)
  const onlineAfterB = Number(idleAppear.snap?.onlineNow) || beforeOnline + 1
  const vanishB = await waitFor(
    (snap) => (Number(snap?.onlineNow) || 0) < onlineAfterB,
    { timeoutMs: MAX_VANISH_MS + 1500, label: 'idle vanish' },
  )
  if (vanishB.ms == null) fail('idle user did not disappear after session/end')
  else if (vanishB.ms > MAX_VANISH_MS) fail(`idle vanish took ${vanishB.ms}ms`)
  else pass(`idle user vanished in ${vanishB.ms}ms`)
  record('idle_vanish_ms', { ms: vanishB.ms })

  console.log('\nEvidence:', JSON.stringify(evidence, null, 2))
  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nRealtime presence verification passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
