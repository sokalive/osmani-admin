import { getPool } from '../db/pool.js'
import {
  getDeviceSubscriptionAccessState,
  hashDeviceFingerprint,
  tryFinalizeActivationForDevice,
} from '../billingStore.js'
import { recoverSubscriptionToDevice } from './subscriptionRecovery.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

/** Active subs in DB where a sibling device_id shares fingerprint via trial but has no active sub. */
export async function findMigrationShadowDevices(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT DISTINCT
       dte_new.device_id AS shadow_device_id,
       ds_source.device_id AS source_device_id,
       dte_new.fingerprint_hash
     FROM device_subscriptions ds_source
     INNER JOIN device_trial_entitlements dte_src ON dte_src.device_id = ds_source.device_id
     INNER JOIN device_trial_entitlements dte_new
       ON dte_new.fingerprint_hash = dte_src.fingerprint_hash
      AND dte_new.fingerprint_hash <> ''
      AND dte_new.device_id <> ds_source.device_id
     LEFT JOIN device_subscriptions ds_new
       ON ds_new.device_id = dte_new.device_id
      AND ds_new.status = 'active'
      AND ds_new.expires_at > now()
     WHERE ds_source.status = 'active'
       AND ds_source.expires_at > now()
       AND ds_new.device_id IS NULL
     ORDER BY dte_new.device_id
     LIMIT 500`,
  )
  return rows
}

/** Completed payments without matching active subscription row. */
export async function findOrphanCompletedActivations(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT DISTINCT t.device_id::text AS device_id, t.order_id
     FROM transactions t
     WHERE t.status = 'completed'
       AND t.plan_id IS NOT NULL
       AND COALESCE(t.device_id, '') <> ''
       AND NOT EXISTS (
         SELECT 1 FROM device_subscriptions ds
         WHERE ds.device_id = t.device_id
           AND ds.status = 'active'
           AND ds.expires_at > now()
       )
     ORDER BY t.device_id
     LIMIT 500`,
  )
  return rows
}

export async function countActiveSubscriptions(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_subscriptions
     WHERE status = 'active' AND expires_at > now()`,
  )
  return rows[0]?.n ?? 0
}

export async function backfillSubscriptionFingerprintsFromTrial(pool = requirePool()) {
  const result = await pool.query(
    `UPDATE device_subscriptions ds
     SET fingerprint_hash = dte.fingerprint_hash, updated_at = now()
     FROM device_trial_entitlements dte
     WHERE ds.device_id = dte.device_id
       AND ds.status = 'active'
       AND ds.expires_at > now()
       AND (ds.fingerprint_hash IS NULL OR ds.fingerprint_hash = '')
       AND dte.fingerprint_hash IS NOT NULL
       AND dte.fingerprint_hash <> ''`,
  )
  return Number(result.rowCount) || 0
}

async function probeDeviceActive(deviceId, fingerprintHash = null) {
  const row = await getDeviceSubscriptionAccessState(deviceId, null)
  const activeByDevice = row?.active_now === true && row?.blocked_now !== true
  return { deviceId, activeByDevice, expiresAt: row?.expires_at ?? null, blocked: row?.blocked_now === true }
}

/**
 * @param {{ repair?: boolean }} opts
 */
export async function runSubscriptionRestorationAudit(opts = {}) {
  const repair = opts.repair === true
  const pool = requirePool()
  const report = {
    ok: true,
    server_time: new Date().toISOString(),
    total_active_subscriptions: 0,
    affected_users_count: 0,
    migration_shadow_count: 0,
    orphan_activation_count: 0,
    missing_fingerprint_count: 0,
    restored_users_count: 0,
    unresolved_users_count: 0,
    repairs: {
      fingerprints_backfilled: 0,
      migrations_recovered: 0,
      activations_finalized: 0,
    },
    unresolved: [],
    evidence: [],
  }

  report.total_active_subscriptions = await countActiveSubscriptions(pool)

  const missingFp = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_subscriptions
     WHERE status = 'active' AND expires_at > now()
       AND (fingerprint_hash IS NULL OR fingerprint_hash = '')`,
  )
  report.missing_fingerprint_count = missingFp.rows[0]?.n ?? 0

  const shadows = await findMigrationShadowDevices(pool)
  report.migration_shadow_count = shadows.length

  const orphans = await findOrphanCompletedActivations(pool)
  report.orphan_activation_count = orphans.length

  report.affected_users_count = shadows.length + orphans.length

  if (repair) {
    report.repairs.fingerprints_backfilled = await backfillSubscriptionFingerprintsFromTrial(pool)

    for (const row of shadows) {
      const target = String(row.shadow_device_id || '').trim()
      const hash = String(row.fingerprint_hash || '').trim()
      if (!target || !hash) continue
      try {
        const rec = await recoverSubscriptionToDevice(target, hash, { reason: 'audit_repair' })
        if (rec.recovered) report.repairs.migrations_recovered += 1
      } catch (e) {
        report.unresolved.push({
          type: 'migration_shadow',
          device_id: target,
          error: String(e.message || e),
        })
      }
    }

    for (const row of orphans) {
      const deviceId = String(row.device_id || '').trim()
      if (!deviceId) continue
      try {
        const fin = await tryFinalizeActivationForDevice(deviceId)
        if (fin.activated === true) report.repairs.activations_finalized += 1
      } catch (e) {
        report.unresolved.push({
          type: 'orphan_activation',
          device_id: deviceId,
          order_id: row.order_id,
          error: String(e.message || e),
        })
      }
    }
  }

  const shadowsAfter = repair ? await findMigrationShadowDevices(pool) : shadows
  const orphansAfter = repair ? await findOrphanCompletedActivations(pool) : orphans

  for (const row of shadowsAfter) {
    const probe = await probeDeviceActive(row.shadow_device_id)
    if (!probe.activeByDevice) {
      report.unresolved.push({
        type: 'migration_shadow_unresolved',
        shadow_device_id: row.shadow_device_id,
        source_device_id: row.source_device_id,
      })
    }
  }

  for (const row of orphansAfter) {
    const probe = await probeDeviceActive(row.device_id)
    if (!probe.activeByDevice) {
      report.unresolved.push({
        type: 'orphan_activation_unresolved',
        device_id: row.device_id,
        order_id: row.order_id,
      })
    }
  }

  const uniqueUnresolved = new Map()
  for (const u of report.unresolved) {
    const key = u.device_id || u.shadow_device_id || JSON.stringify(u)
    uniqueUnresolved.set(key, u)
  }
  report.unresolved = [...uniqueUnresolved.values()]
  report.unresolved_users_count = report.unresolved.length
  if (repair) {
    report.restored_users_count =
      report.repairs.migrations_recovered +
      report.repairs.activations_finalized
  } else {
    report.restored_users_count = Math.max(
      0,
      report.affected_users_count - report.unresolved_users_count,
    )
  }

  report.evidence.push({
    active_subscriptions: report.total_active_subscriptions,
    migration_shadow_remaining: shadowsAfter.length,
    orphan_activation_remaining: orphansAfter.length,
    missing_fingerprint_remaining: (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM device_subscriptions
         WHERE status = 'active' AND expires_at > now()
           AND (fingerprint_hash IS NULL OR fingerprint_hash = '')`,
      )
    ).rows[0]?.n,
  })

  report.ok = report.unresolved_users_count === 0
  return report
}

export function hashFingerprintForAudit(raw) {
  return hashDeviceFingerprint(raw)
}
