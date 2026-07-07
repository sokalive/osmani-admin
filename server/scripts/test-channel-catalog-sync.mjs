/**
 * Unit checks for channel catalog sync payload shape (no live API).
 */
import assert from 'node:assert/strict'
import { liveSyncBus } from '../src/lib/liveSyncBus.js'

function buildChannelsCatalogSseBody(packet) {
  return {
    v: packet.configVersion,
    event: packet.event,
    action: packet?.payload?.action ?? null,
    channelId: packet?.payload?.channelId ?? packet?.payload?.channel?.id ?? null,
    channel: packet?.payload?.channel ?? null,
    catalog_revision: packet?.payload?.catalog_revision ?? packet.configVersion ?? null,
    routing_epoch: packet?.payload?.routing_epoch ?? null,
    updatedAt: packet?.payload?.synced_at ?? null,
    reason: String(packet.event || 'sync'),
  }
}

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed += 1
    console.log('PASS', name)
  } catch (e) {
    failed += 1
    console.error('FAIL', name, e?.message || e)
  }
}

test('publish bumps configVersion and includes channel patch fields', () => {
  const channelPatch = {
    id: 42,
    access_type: 'premium',
    accessType: 'premium',
    accessPremium: true,
    access_premium: true,
    is_active: true,
    show_in_app: true,
    updated_at: '2026-07-07T10:00:00.000Z',
  }
  const before = liveSyncBus.snapshot().configVersion
  const packet = liveSyncBus.publish('config.channels_changed', {
    topics: ['config'],
    action: 'updated',
    channelId: 42,
    channel: channelPatch,
    catalog_revision: before + 1,
    synced_at: '2026-07-07T10:00:01.000Z',
  })
  assert.equal(packet.configVersion, before + 1)
  assert.equal(packet.payload.channel.id, 42)
  assert.equal(packet.payload.channel.accessPremium, true)
})

test('SSE body includes channel patch and catalog_revision for App patch apply', () => {
  const packet = liveSyncBus.publish('config.channels_changed', {
    topics: ['config'],
    action: 'updated',
    channelId: 7,
    channel: {
      id: 7,
      accessType: 'free',
      accessPremium: false,
      updated_at: '2026-07-07T10:00:00.000Z',
    },
    catalog_revision: liveSyncBus.snapshot().configVersion + 1,
    synced_at: '2026-07-07T10:00:02.000Z',
  })
  packet.payload.catalog_revision = packet.configVersion
  const body = buildChannelsCatalogSseBody(packet)
  assert.equal(body.channelId, 7)
  assert.equal(body.channel.accessType, 'free')
  assert.equal(body.catalog_revision, packet.configVersion)
  assert.equal(body.v, packet.configVersion)
})

test('monotonic catalog_revision across rapid publishes', () => {
  const revisions = []
  for (let i = 0; i < 5; i++) {
    const p = liveSyncBus.publish('config.channels_changed', {
      topics: ['config'],
      action: 'updated',
      channelId: 1,
      channel: { id: 1, accessType: i % 2 ? 'premium' : 'free', accessPremium: i % 2 === 1 },
    })
    revisions.push(p.configVersion)
  }
  for (let i = 1; i < revisions.length; i++) {
    assert.ok(revisions[i] > revisions[i - 1], 'revision must increase')
  }
})

console.log(`\n=== ${passed} passed, ${failed} failed ===`)
process.exit(failed > 0 ? 1 : 0)
