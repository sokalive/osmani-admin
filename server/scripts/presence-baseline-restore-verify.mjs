/**
 * Pre-commit / local verify for restoring pre-telemetry presence UX (89557d6)
 * while retaining pool-stability commits.
 *
 * Usage: node server/scripts/presence-baseline-restore-verify.mjs
 */
import { createRefreshCoordinator } from '../../src/lib/adminRefreshCoordinator.js'
import { liveSyncBus } from '../src/lib/liveSyncBus.js'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// Browser coordinator uses window.*; provide a Node shim for harness only.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '../..')
const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function testCoordinatorBaselineFast() {
  let runs = 0
  const coord = createRefreshCoordinator(
    async () => {
      runs += 1
    },
    { debounceMs: 50, minIntervalMs: 400 },
  )
  const t0 = Date.now()
  for (let i = 0; i < 50; i += 1) coord.schedule()
  await new Promise((r) => setTimeout(r, 120))
  assert(runs === 1, `expected 1 coalesced run after burst, got ${runs}`)
  // After minInterval, another burst should run again quickly (not 10s).
  await new Promise((r) => setTimeout(r, 450))
  for (let i = 0; i < 20; i += 1) coord.schedule()
  await new Promise((r) => setTimeout(r, 120))
  assert(runs === 2, `expected 2nd run within ~600ms window, got ${runs}`)
  const elapsed = Date.now() - t0
  assert(elapsed < 1500, `baseline coordinator too slow: ${elapsed}ms`)
  return { runs, elapsedMs: elapsed, ok: true }
}

async function testHeartbeatPublishImmediate() {
  // Restored livePresenceSync always publishes; simulate high fan-out of bus events.
  const events = []
  const onSync = (p) => events.push(p.event)
  liveSyncBus.on('sync', onSync)
  try {
    for (let i = 0; i < 100; i += 1) {
      liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId: `u-${i}` })
    }
    assert(events.length === 100, `expected 100 immediate publishes, got ${events.length}`)
    assert(
      !existsSync(resolve(root, 'server/src/lib/presenceHeartbeatPublish.js')),
      'presenceHeartbeatPublish.js must be removed',
    )
    assert(
      !existsSync(resolve(root, 'server/src/lib/presenceEventPublish.js')),
      'presenceEventPublish.js must be removed',
    )
    return { published: events.length, ok: true }
  } finally {
    liveSyncBus.off('sync', onSync)
  }
}

async function testConcurrentHeartbeatStormCoalesce() {
  // Many concurrent heartbeat schedules should coalesce via coordinator, not block for 10s.
  let runs = 0
  const coord = createRefreshCoordinator(
    async () => {
      runs += 1
      await new Promise((r) => setTimeout(r, 5))
    },
    { debounceMs: 50, minIntervalMs: 400 },
  )
  const t0 = Date.now()
  // Simulate ~200 concurrent users publishing within ~1s
  for (let wave = 0; wave < 5; wave += 1) {
    for (let i = 0; i < 40; i += 1) coord.schedule()
    await new Promise((r) => setTimeout(r, 200))
  }
  await new Promise((r) => setTimeout(r, 500))
  const elapsed = Date.now() - t0
  // With 400ms minInterval over ~1.5s of waves, expect a handful of runs, not 200.
  assert(runs >= 2 && runs <= 12, `unexpected run count under load: ${runs}`)
  assert(elapsed < 3000, `load harness took too long: ${elapsed}`)
  return { runs, elapsedMs: elapsed, ok: true }
}

async function probeProductionReadOnly() {
  const health = await fetch(`${API}/api/health`).then((r) => r.json())
  const snap = await fetch(`${API}/api/analytics/snapshot`).then((r) => r.json())
  const plansRes = await fetch(`${API}/api/plans`)
  const plansBody = await plansRes.json().catch(() => null)
  const online = Number(snap.onlineNow) || 0
  const watching = Number(snap.watchingNow) || 0
  const idle = Number(snap.idleNow) || 0
  return {
    commit: health.commit,
    pool: health.pool,
    sumOk: online === watching + idle,
    online,
    watching,
    idle,
    poolSaturated: health.pool?.saturated === true,
    waitingCount: Number(health.pool?.waitingCount) || 0,
    plansOk:
      plansRes.status === 200 &&
      (Array.isArray(plansBody) ||
        Array.isArray(plansBody?.plans) ||
        Array.isArray(plansBody?.data)),
  }
}

const out = {
  coordinator: await testCoordinatorBaselineFast(),
  heartbeatPublishImmediate: await testHeartbeatPublishImmediate(),
  concurrentLoad: await testConcurrentHeartbeatStormCoalesce(),
  productionBeforeDeploy: await probeProductionReadOnly(),
}
console.log(JSON.stringify(out, null, 2))
console.log('presence-baseline-restore-verify: PASS')
