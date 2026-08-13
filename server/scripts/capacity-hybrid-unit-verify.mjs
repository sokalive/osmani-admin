/**
 * Local unit verify for capacity hybrid (no production writes).
 */
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis

import { createRefreshCoordinator } from '../../src/lib/adminRefreshCoordinator.js'
import {
  shouldPublishSessionHeartbeat,
  getHeartbeatPublishMinMs,
  markSessionHeartbeatPublished,
} from '../src/lib/presenceHeartbeatPublish.js'
import { publishAfterLivePresenceUpsert } from '../src/lib/presenceEventPublish.js'
import { liveSyncBus } from '../src/lib/liveSyncBus.js'
import {
  shouldSkipOrdinaryPresenceUpsert,
  markOrdinaryPresenceWritten,
  canUseBackgroundDb,
  criticalPoolHeadroom,
} from '../src/lib/telemetryAdmission.js'
import { isLikelyMeaningfulPresenceRequest } from '../src/lib/livePresenceSync.js'
import { existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function testCoordinator() {
  let runs = 0
  const coord = createRefreshCoordinator(
    async () => {
      runs += 1
    },
    { debounceMs: 40, minIntervalMs: 10_000 },
  )
  for (let i = 0; i < 100; i += 1) coord.schedule({ minIntervalMs: 10_000 })
  await new Promise((r) => setTimeout(r, 120))
  assert(runs === 1, `heartbeat coalesce expected 1, got ${runs}`)
  coord.schedule({ minIntervalMs: 600 })
  await new Promise((r) => setTimeout(r, 800))
  assert(runs === 2, `presence_changed should allow 2nd run, got ${runs}`)
  return { ok: true, runs }
}

async function testPublishSplit() {
  const events = []
  const on = (p) => events.push(p.event)
  liveSyncBus.on('sync', on)
  try {
    const id = `u-${Date.now()}`
    markSessionHeartbeatPublished(id)
    const quiet = publishAfterLivePresenceUpsert(id, {
      presenceChanged: false,
      channelId: '1',
      previousChannelId: '1',
    })
    assert(quiet.published === false, 'ordinary heartbeat should stay quiet')
    const open = publishAfterLivePresenceUpsert(id, {
      presenceChanged: true,
      channelId: '1',
      previousChannelId: null,
      channelChanged: true,
    })
    assert(open.event === 'analytics.presence_changed', open.event)
    assert(events.includes('analytics.presence_changed'), 'must emit presence_changed')
    assert(existsSync(resolve(root, 'server/src/lib/presenceEventPublish.js')))
    return { ok: true, events, minMs: getHeartbeatPublishMinMs() }
  } finally {
    liveSyncBus.off('sync', on)
  }
}

async function testHeartbeatGate() {
  const id = `hb-${Date.now()}`
  let n = 0
  for (let i = 0; i < 20; i += 1) if (shouldPublishSessionHeartbeat(id)) n += 1
  assert(n === 1, `expected 1 publish in burst, got ${n}`)
  return { ok: true }
}

async function testAdmissionAndMeaningful() {
  assert(criticalPoolHeadroom(40) >= 8, 'headroom clamp')
  assert(criticalPoolHeadroom(50) === 12, `expected 12 got ${criticalPoolHeadroom(50)}`)
  assert(criticalPoolHeadroom(60) === 15, `expected 15 got ${criticalPoolHeadroom(60)}`)
  assert(canUseBackgroundDb() === true, 'no pool => allow background')

  const id = `adm-${Date.now()}`
  assert(
    isLikelyMeaningfulPresenceRequest(id, {
      clearChannel: false,
      channelRef: { channelId: '1' },
      hint: null,
      event: 'analytics.session_heartbeat',
    }) === true,
    'open must be meaningful',
  )
  assert(
    isLikelyMeaningfulPresenceRequest(id, {
      clearChannel: true,
      channelRef: { channelId: null },
      hint: null,
      event: 'analytics.session_heartbeat',
    }) === true,
    'explicit clear/leave must be meaningful even without hint',
  )
  assert(
    isLikelyMeaningfulPresenceRequest(id, {
      clearChannel: false,
      channelRef: { channelId: '1' },
      hint: { channelId: '1' },
      event: 'analytics.session_heartbeat',
    }) === false,
    'same-state must be ordinary',
  )
  assert(shouldSkipOrdinaryPresenceUpsert(id, { meaningful: true }) === false, 'meaningful never skips')
  markOrdinaryPresenceWritten(id)
  assert(shouldSkipOrdinaryPresenceUpsert(id, { meaningful: false }) === false)
  return { ok: true, headroom50: criticalPoolHeadroom(50) }
}

const out = {
  coordinator: await testCoordinator(),
  publishSplit: await testPublishSplit(),
  heartbeatGate: await testHeartbeatGate(),
  admission: await testAdmissionAndMeaningful(),
}
console.log(JSON.stringify(out, null, 2))
console.log('capacity-hybrid-unit-verify: PASS')
