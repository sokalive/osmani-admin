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
import { isIntentionalMigrationRevokedDevice } from './transferRevocationGuard.js'

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
  const pairByKey = new Map()
  const rank = { install_instance_shadow: 2, payment_phone_shadow: 1, fingerprint_trial_shadow: 0 }
  for (const row of rows) {
    const a = String(row.device_id || row.shadow_device_id || '').trim()
    const b = String(row.source_device_id || '').trim()
    const reason = String(row.match_reason || '')
    if (!a || !b || a === b) continue
    const key = [a, b].sort().join('|')
    const prev = pairByKey.get(key)
    if (!prev || (rank[reason] ?? 0) > (rank[prev.reason] ?? 0)) {
      pairByKey.set(key, { a, b, reason })
    }
  }
  return [...pairByKey.values()]
}

/** Pick inactive user device as migration target; active paid device as source (prevents install_instance ping-pong). */
async function resolveMigrationDirection(pair, probeActive) {
  const aActive = await probeActive(pair.a)
  const bActive = await probeActive(pair.b)
  if (aActive && bActive) return null
  const aRevoked = await isIntentionalMigrationRevokedDevice(pair.a)
  const bRevoked = await isIntentionalMigrationRevokedDevice(pair.b)
  if (aActive && !bActive && !bRevoked) return { target: pair.b, source: pair.a, reason: pair.reason }
  if (!aActive && bActive && !aRevoked) return { target: pair.a, source: pair.b, reason: pair.reason }
  return null
}

/**
 * @param {{ shadowLimit?: number, orphanLimit?: number }} opts
 */
export async function runDirectShadowRepairBatch(opts = {}) {
  const pool = requirePool()
  const shadowLimit = Math.max(0, Math.min(50, Number(opts.shadowLimit) || 10))
  const orphanLimit = Math.max(0, Math.min(20, Number(opts.orphanLimit) || 5))

  const shadowOpts = { requireTelemetry: false }

  const before = {
    shadows: (await findIncorrectlyRevokedMigrationShadows(pool, shadowOpts)).length,
    suspended: (await findIncorrectlySuspendedActive(pool)).length,
    orphans: (await findOrphanCompletedActivations(pool)).length,
  }

  const pairs = dedupeShadowPairs(await findIncorrectlyRevokedMigrationShadows(pool, shadowOpts))
  const resolved = []
  for (const pair of pairs) {
    const dir = await resolveMigrationDirection(pair, probeActive)
    if (dir) resolved.push(dir)
  }
  const batch = resolved.slice(0, shadowLimit)
  const migrated = []
  const failed = []

  for (const { target, source, reason } of batch) {
    try {
      if (await probeActive(target)) {
        migrated.push({ device_id: target, source_device_id: source, reason, method: 'already_active' })
        continue
      }
      if (!(await probeActive(source))) {
        failed.push({ device_id: target, source_device_id: source, reason, error: 'source_not_active' })
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
    shadows: (await findIncorrectlyRevokedMigrationShadows(pool, shadowOpts)).length,
    suspended: (await findIncorrectlySuspendedActive(pool)).length,
    orphans: (await findOrphanCompletedActivations(pool)).length,
  }

  return {
    ok: after.shadows === 0 && after.suspended === 0 && failed.length === 0,
    before,
    after,
    remaining_unique_shadows: (await (async () => {
      const raw = dedupeShadowPairs(await findIncorrectlyRevokedMigrationShadows(pool, shadowOpts))
      let n = 0
      for (const pair of raw) {
        const dir = await resolveMigrationDirection(pair, probeActive)
        if (dir && !(await probeActive(dir.target))) n += 1
      }
      return n
    })()),
    batch_size: batch.length,
    migrated,
    orphans_finalized: orphansFinalized,
    failed,
  }
}

/**
 * Run shadow repair batches until remaining_unique_shadows reaches 0 or no progress.
 */
export async function runDirectShadowRepairUntilZero(opts = {}) {
  const maxRounds = Math.max(1, Math.min(100, Number(opts.maxRounds) || 50))
  const shadowLimit = Math.max(1, Math.min(50, Number(opts.shadowLimit) || 20))
  const orphanLimit = Math.max(0, Math.min(20, Number(opts.orphanLimit) || 5))
  const rounds = []
  let last = null

  for (let i = 0; i < maxRounds; i++) {
    last = await runDirectShadowRepairBatch({ shadowLimit, orphanLimit })
    rounds.push({
      round: i + 1,
      migrated: last.migrated?.length ?? 0,
      failed: last.failed?.length ?? 0,
      remaining_unique_shadows: last.remaining_unique_shadows,
      shadows: last.after?.shadows,
    })
    if ((last.remaining_unique_shadows ?? 0) === 0 && (last.after?.shadows ?? 0) === 0) {
      return { ok: true, rounds, last }
    }
    const progressed =
      (last.migrated?.length ?? 0) > 0 || (last.orphans_finalized?.length ?? 0) > 0
    if (!progressed) break
  }

  return {
    ok: (last?.remaining_unique_shadows ?? 1) === 0 && (last?.after?.shadows ?? 1) === 0,
    rounds,
    last,
  }
}
