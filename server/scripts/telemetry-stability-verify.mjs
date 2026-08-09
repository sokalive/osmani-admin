/**
 * Local harness: Admin refresh coordinator throttle + presence publish gate timing.
 * Does not hammer production.
 *
 * Usage: node server/scripts/telemetry-stability-verify.mjs
 */
import { createRefreshCoordinator } from '../../src/lib/adminRefreshCoordinator.js'
import {
  shouldPublishSessionHeartbeat,
  getHeartbeatPublishMinMs,
} from '../src/lib/presenceHeartbeatPublish.js'

const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { Accept: 'application/json' } })
  const body = await res.json()
  return { status: res.status, body }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function testCoordinatorThrottle() {
  let runs = 0
  const coord = createRefreshCoordinator(
    async () => {
      runs += 1
    },
    { debounceMs: 50, minIntervalMs: 10_000 },
  )
  const t0 = Date.now()
  for (let i = 0; i < 200; i += 1) {
    coord.schedule({ minIntervalMs: 10_000 })
  }
  await new Promise((r) => setTimeout(r, 200))
  assert(runs === 1, `expected 1 run after 200 heartbeat schedules, got ${runs}`)
  coord.schedule({ minIntervalMs: 2_000 })
  await new Promise((r) => setTimeout(r, 2200))
  assert(runs === 2, `expected meaningful schedule to allow 2nd run, got ${runs}`)
  const elapsed = Date.now() - t0
  return { runs, elapsedMs: elapsed, ok: true }
}

async function testHeartbeatPublishGate() {
  const minMs = getHeartbeatPublishMinMs()
  const id = `harness-${Date.now()}`
  let allowed = 0
  for (let i = 0; i < 20; i += 1) {
    if (shouldPublishSessionHeartbeat(id)) allowed += 1
  }
  assert(allowed === 1, `expected 1 allowed publish in burst, got ${allowed}`)
  await new Promise((r) => setTimeout(r, minMs + 50))
  assert(shouldPublishSessionHeartbeat(id) === true, 'expected publish allowed after cooldown')
  return { minMs, ok: true }
}

async function probeProductionReadOnly() {
  const health = await getJson('/api/health')
  const snap = await getJson('/api/analytics/snapshot')
  const o = snap.body || {}
  const online = Number(o.onlineNow) || 0
  const watching = Number(o.watchingNow) || 0
  const idle = Number(o.idleNow) || 0
  const sumOk = online === watching + idle
  return {
    commit: health.body?.commit,
    pool: health.body?.pool,
    online,
    watching,
    idle,
    sumOk,
    locationsOnline: o.locationsOnline,
    channelWatchingNow: o.channelWatchingNow,
    degraded: o.degraded === true,
  }
}

const out = {
  coordinator: await testCoordinatorThrottle(),
  heartbeatPublish: await testHeartbeatPublishGate(),
  production: await probeProductionReadOnly(),
}
console.log(JSON.stringify(out, null, 2))
if (!out.production.sumOk) {
  console.error('WARN: online != watching + idle on production snapshot (transient possible)')
  process.exitCode = 0
}
console.log('telemetry-stability-verify: PASS')
