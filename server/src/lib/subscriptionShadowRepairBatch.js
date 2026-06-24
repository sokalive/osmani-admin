/**
 * Batch direct shadow migration repair (production-safe, bounded runtime).
 */
import { getPool } from '../db/pool.js'
import { getDeviceSubscriptionAccessState, tryFinalizeActivationForDevice } from '../billingStore.js'
import { migrateSubscriptionFromSourceDevice } from './subscriptionRecovery.js'
import {
  findIncorrectlyRevokedMigrationShadows,
  findIncorrectlySuspendedActive,
} from './subscriptionIncidentAudit.js'
import { findOrphanCompletedActivations } from './subscriptionRestorationAudit.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

async function probeActive(deviceId) {
  const row = await getDeviceSubscriptionAccessState(deviceId, null)
  return row?.active_now === true && row?.blocked_now !== true
}

function dedupeShadowPairs(rows) {
  const pairByTarget = new Map()
  const rank = { install_instance_shadow: 2, payment_phone_shadow: 1, fingerprint_trial_shadow: 0 }
  for (const row of rows) {
    const target = String(row.device_id || row.shadow_device_id || '').trim()
    const source = String(row.source_device_id || '').trim()
    const reason = String(row.match_reason || '')
    if (!target || !source) continue
    const prev = pairByTarget.get(target)
    if (!prev || (rank[reason] ?? 0) > (rank[prev.reason] ?? 0)) {
      pairByTarget.set(target, { target, source, reason })
    }
  }
  return [...pairByTarget.values()]
}

/**
 * @param {{ shadowLimit?: number, orphanLimit?: number }} opts
 */
export async function runDirectShadowRepairBatch(opts = {}) {
  const pool = requirePool()
  const shadowLimit = Math.max(0, Math.min(50, Number(opts.shadowLimit) || 10))
  const orphanLimit = Math.max(0, Math.min(20, Number(opts.orphanLimit) || 5))

  const before = {
    shadows: (await findIncorrectlyRevokedMigrationShadows(pool)).length,
    suspended: (await findIncorrectlySuspendedActive(pool)).length,
    orphans: (await findOrphanCompletedActivations(pool)).length,
  }

  const pairs = dedupeShadowPairs(await findIncorrectlyRevokedMigrationShadows(pool))
  const batch = pairs.slice(0, shadowLimit)
  const migrated = []
  const failed = []

  for (const { target, source, reason } of batch) {
    try {
      if (await probeActive(target)) {
        migrated.push({ device_id: target, source_device_id: source, reason, method: 'already_active' })
        continue
      }
      const mig = await migrateSubscriptionFromSourceDevice(target, source)
      if (mig.recovered) {
        migrated.push({
          device_id: target,
          source_device_id: source,
          reason,
          verify_active: await probeActive(target),
        })
      } else {
        failed.push({ device_id: target, source_device_id: source, reason, error: mig.reason || 'not_recovered' })
      }
    } catch (e) {
      failed.push({ device_id: target, source_device_id: source, reason, error: String(e.message || e) })
    }
  }

  const orphans = (await findOrphanCompletedActivations(pool)).slice(0, orphanLimit)
  const orphansFinalized = []
  for (const row of orphans) {
    const deviceId = String(row.device_id || '').trim()
    if (!deviceId) continue
    try {
      const fin = await tryFinalizeActivationForDevice(deviceId)
      if (fin.activated === true) {
        orphansFinalized.push({
          device_id: deviceId,
          order_id: row.order_id,
          verify_active: await probeActive(deviceId),
        })
      }
    } catch (e) {
      failed.push({ device_id: deviceId, reason: 'orphan_activation', error: String(e.message || e) })
    }
  }

  const after = {
    shadows: (await findIncorrectlyRevokedMigrationShadows(pool)).length,
    suspended: (await findIncorrectlySuspendedActive(pool)).length,
    orphans: (await findOrphanCompletedActivations(pool)).length,
  }

  return {
    ok: after.shadows === 0 && after.suspended === 0 && failed.length === 0,
    before,
    after,
    remaining_unique_shadows: dedupeShadowPairs(await findIncorrectlyRevokedMigrationShadows(pool)).length,
    batch_size: batch.length,
    migrated,
    orphans_finalized: orphansFinalized,
    failed,
  }
}
