/**
 * Smoke test for Users Intelligence store (requires DATABASE_URL).
 * Run: node server/scripts/test-users-intelligence.mjs
 */
import { ensureBillingStorage } from '../src/billingStore.js'
import {
  backfillDeviceIntelligenceFromExisting,
  blockDeviceIntelligenceUser,
  getDeviceIntelligenceByDeviceId,
  getDeviceIntelligenceSummary,
  listDeviceIntelligenceRegistry,
  registerDeviceIntelligence,
  unblockDeviceIntelligenceUser,
} from '../src/lib/deviceIntelligenceStore.js'

const testDevice = `ui-test-${Date.now()}`

async function main() {
  await ensureBillingStorage()
  const reg = await registerDeviceIntelligence({
    deviceId: testDevice,
    phoneNumber: '255700000001',
    deviceFingerprint: 'fp-test',
    androidId: 'aid-test',
    deviceModel: 'TestPhone',
    deviceBrand: 'TestBrand',
    osVersion: '14',
    appVersion: '9.9.9',
  })
  if (!reg?.id) throw new Error('register failed')
  if (reg.blocked) throw new Error('new device should not be blocked')

  const blocked = await blockDeviceIntelligenceUser(reg.id, {
    reason: 'automated test',
    adminEmail: 'test@local',
  })
  if (blocked?.status !== 'blocked') throw new Error('block failed')

  const check = await getDeviceIntelligenceByDeviceId(testDevice)
  if (check?.status !== 'blocked') throw new Error('blocked status not persisted')

  await unblockDeviceIntelligenceUser(reg.id, { adminEmail: 'test@local' })
  const active = await getDeviceIntelligenceByDeviceId(testDevice)
  if (active?.status !== 'active') throw new Error('unblock failed')

  const summary = await getDeviceIntelligenceSummary()
  if (typeof summary.totalDevicesEverSeen !== 'number') throw new Error('summary invalid')

  const list = await listDeviceIntelligenceRegistry({ q: testDevice })
  if (!list.some((r) => r.deviceId === testDevice)) throw new Error('search list failed')

  await backfillDeviceIntelligenceFromExisting()

  console.log('[test-users-intelligence] OK', { deviceId: testDevice, summary })
}

main().catch((e) => {
  console.error('[test-users-intelligence] FAIL', e)
  process.exit(1)
})
