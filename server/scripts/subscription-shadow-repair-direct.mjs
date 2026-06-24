/**
 * Fast direct migration repair — deduped shadow pairs, no 300-row auto_link scan.
 *   cd server && node scripts/subscription-shadow-repair-direct.mjs
 */
import '../src/loadEnv.js'
import { getPool } from '../src/db/pool.js'
import { getDeviceSubscriptionAccessState, tryFinalizeActivationForDevice } from '../src/billingStore.js'
import { migrateSubscriptionFromSourceDevice } from '../src/lib/subscriptionRecovery.js'
import {
  findIncorrectlyRevokedMigrationShadows,
  findIncorrectlySuspendedActive,
} from '../src/lib/subscriptionIncidentAudit.js'
import { findOrphanCompletedActivations } from '../src/lib/subscriptionRestorationAudit.js'

const pool = getPool()
if (!pool) {
  console.error('DATABASE_URL required')
  process.exit(1)
}

const report = {
  before: { shadows: 0, suspended: 0, orphans: 0 },
  repairs: { migrated: 0, orphans_finalized: 0, failed: [] },
  after: { shadows: 0, suspended: 0, orphans: 0 },
  restored_devices: [],
}

async function probeActive(deviceId) {
  const row = await getDeviceSubscriptionAccessState(deviceId, null)
  return row?.active_now === true && row?.blocked_now !== true
}

const suspendedBefore = await findIncorrectlySuspendedActive(pool)
const shadowsBefore = await findIncorrectlyRevokedMigrationShadows(pool)
const orphansBefore = await findOrphanCompletedActivations(pool)
report.before.suspended = suspendedBefore.length
report.before.shadows = shadowsBefore.length
report.before.orphans = orphansBefore.length

/** Dedupe: one source per shadow device (prefer install_instance over payment_phone). */
const pairByTarget = new Map()
const rank = { install_instance_shadow: 2, payment_phone_shadow: 1, fingerprint_trial_shadow: 0 }
for (const row of shadowsBefore) {
  const target = String(row.device_id || '').trim()
  const source = String(row.source_device_id || '').trim()
  const reason = String(row.match_reason || '')
  if (!target || !source) continue
  const prev = pairByTarget.get(target)
  if (!prev || (rank[reason] ?? 0) > (rank[prev.reason] ?? 0)) {
    pairByTarget.set(target, { target, source, reason })
  }
}

console.log(`Repairing ${pairByTarget.size} unique shadow device(s)...`)

for (const { target, source, reason } of pairByTarget.values()) {
  try {
    if (await probeActive(target)) {
      report.repairs.migrated += 1
      report.restored_devices.push({ device_id: target, method: 'already_active', source, reason })
      continue
    }
    const mig = await migrateSubscriptionFromSourceDevice(target, source)
    if (mig.recovered) {
      const ok = await probeActive(target)
      report.repairs.migrated += 1
      report.restored_devices.push({
        device_id: target,
        source_device_id: source,
        reason,
        verify_active: ok,
      })
      console.log(`OK migrated ${target.slice(0, 20)}… <- ${source.slice(0, 20)}… (${reason}) active=${ok}`)
    } else {
      report.repairs.failed.push({ target, source, reason, error: mig.reason || 'not_recovered' })
      console.error(`FAIL ${target.slice(0, 24)}… reason=${mig.reason}`)
    }
  } catch (e) {
    report.repairs.failed.push({ target, source, reason, error: String(e.message || e) })
    console.error(`ERR ${target.slice(0, 24)}…`, e.message || e)
  }
}

for (const row of orphansBefore) {
  const deviceId = String(row.device_id || '').trim()
  if (!deviceId) continue
  try {
    const fin = await tryFinalizeActivationForDevice(deviceId)
    if (fin.activated === true) {
      report.repairs.orphans_finalized += 1
      if (await probeActive(deviceId)) {
        report.restored_devices.push({ device_id: deviceId, method: 'orphan_finalize', order_id: row.order_id })
      }
    }
  } catch (e) {
    report.repairs.failed.push({ target: deviceId, reason: 'orphan_activation', error: String(e.message || e) })
  }
}

const shadowsAfter = await findIncorrectlyRevokedMigrationShadows(pool)
const suspendedAfter = await findIncorrectlySuspendedActive(pool)
const orphansAfter = await findOrphanCompletedActivations(pool)
report.after.shadows = shadowsAfter.length
report.after.suspended = suspendedAfter.length
report.after.orphans = orphansAfter.length

console.log('\n=== DIRECT REPAIR SUMMARY ===')
console.log(JSON.stringify(report, null, 2))

const ok =
  report.after.shadows === 0 &&
  report.after.suspended === 0 &&
  report.repairs.failed.length === 0
process.exit(ok ? 0 : 1)
