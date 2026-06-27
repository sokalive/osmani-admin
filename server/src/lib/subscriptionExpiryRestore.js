/**
 * Safe subscription restore after expiry repair incidents.
 * Only increases entitlement — never shortens active packages.
 */
import { getPool } from '../db/pool.js'
import {
  getDeviceSubscriptionAccessState,
  tryFinalizeActivationForDevice,
  tryActivateDeviceSubscriptionFromCompletedTxn,
  getTransactionByOrderId,
} from '../billingStore.js'
import {
  loadCreditEventsForDevice,
  replayStackedExpiryFromEvents,
  computeLastPaymentFloorExpiry,
} from './subscriptionExpiryAudit.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { findIncorrectlyRevokedMigrationShadows } from './subscriptionIncidentAudit.js'
import { migrateSubscriptionFromSourceDevice } from './subscriptionRecovery.js'

const MS_TOLERANCE = 2 * 60 * 1000

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function toMs(v) {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

function maskId(id) {
  const s = String(id ?? '').trim()
  if (s.length <= 10) return `${s.slice(0, 4)}…`
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

function isActiveAccess(row) {
  return row?.active_now === true && row?.blocked_now !== true
}

/** Transfer source still in use (telemetry) while active sub sits on transfer target. */
export async function findTransferSourceRestoreCandidates(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT dt.source_device_id::text AS target_device_id,
            dt.target_device_id::text AS source_device_id,
            ds_tgt.expires_at AS source_expires_at,
            'transfer_source_return' AS match_reason
     FROM device_transfers dt
     INNER JOIN device_subscriptions ds_tgt
       ON ds_tgt.device_id = dt.target_device_id
      AND ds_tgt.status = 'active'
      AND ds_tgt.expires_at > now()
     LEFT JOIN device_subscriptions ds_src
       ON ds_src.device_id = dt.source_device_id
      AND ds_src.status = 'active'
      AND ds_src.expires_at > now()
     WHERE dt.status = 'completed'
       AND ds_src.device_id IS NULL
       AND EXISTS (
         SELECT 1 FROM client_api_telemetry tel
         WHERE tel.device_id = dt.source_device_id
           AND tel.created_at > now() - interval '14 days'
       )
     ORDER BY ds_tgt.expires_at DESC
     LIMIT 200`,
  )
  return rows
}

/**
 * Devices with successful payments whose replayed entitlement is still in the future
 * but the subscription row is inactive or under-credited.
 */
export async function findPaymentReplayRestoreCandidates(pool = requirePool(), { sinceDays = 30 } = {}) {
  const days = Math.min(90, Math.max(1, Number(sinceDays) || 30))
  const { rows } = await pool.query(
    `SELECT DISTINCT ds.device_id::text AS device_id,
            ds.status,
            ds.expires_at,
            ds.transaction_id,
            (ds.status = 'active' AND ds.expires_at > now()) AS active_now
     FROM device_subscriptions ds
     INNER JOIN transactions t ON t.device_id = ds.device_id AND t.status = 'completed'
     WHERE COALESCE(t.updated_at, t.created_at) > now() - ($1::int * interval '1 day')
     ORDER BY ds.device_id`,
    [days],
  )

  const victims = []
  for (const sub of rows) {
    const deviceId = String(sub.device_id)
    const events = await loadCreditEventsForDevice(pool, deviceId)
    if (!events.length) continue
    const { expectedExpiresAt } = replayStackedExpiryFromEvents(events)
    const expectedMs = toMs(expectedExpiresAt)
    const actualMs = toMs(sub.expires_at)
    if (expectedMs == null || expectedMs <= Date.now() + MS_TOLERANCE) continue

    const active = sub.active_now === true
    const underCredited = active && actualMs != null && expectedMs > actualMs + MS_TOLERANCE
    const wronglyInactive = !active && expectedMs > Date.now()

    if (!underCredited && !wronglyInactive) continue

    victims.push({
      device_id: deviceId,
      device_id_masked: maskId(deviceId),
      category: wronglyInactive ? 'wrongly_inactive' : 'under_credited',
      actual_expires_at: sub.expires_at instanceof Date ? sub.expires_at.toISOString() : String(sub.expires_at ?? ''),
      expected_expires_at: expectedExpiresAt,
      last_payment_floor: computeLastPaymentFloorExpiry(events),
      credit_events: events.length,
      active_now: active,
    })
  }
  return victims
}

/**
 * Restore one device from payment replay. Never reduces expires_at.
 */
export async function restoreDeviceSubscriptionFromReplay(deviceId, opts = {}) {
  const dryRun = opts.dryRun !== false
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return { restored: false, reason: 'missing_device_id' }

  const events = await loadCreditEventsForDevice(pool, d)
  if (!events.length) return { restored: false, reason: 'no_credit_events', device_id: d }

  const { expectedExpiresAt, steps } = replayStackedExpiryFromEvents(events)
  const expectedMs = toMs(expectedExpiresAt)
  const floorIso = computeLastPaymentFloorExpiry(events)
  const floorMs = toMs(floorIso)
  const safeMs = Math.max(expectedMs ?? 0, floorMs ?? 0)
  if (!safeMs || safeMs <= Date.now() + MS_TOLERANCE) {
    return { restored: false, reason: 'replay_not_future', device_id: d, expected_expires_at: expectedExpiresAt }
  }

  const { rows } = await pool.query(
    `SELECT device_id, status, expires_at, transaction_id
     FROM device_subscriptions WHERE device_id = $1`,
    [d],
  )
  const sub = rows[0]
  const actualMs = toMs(sub?.expires_at)
  const lastEvent = events[events.length - 1]
  const lastOrderId = String(lastEvent.ref ?? '').trim()

  if (actualMs != null && actualMs >= safeMs - MS_TOLERANCE && sub?.status === 'active' && actualMs > Date.now()) {
    return {
      restored: false,
      reason: 'already_sufficient',
      device_id: d,
      actual_expires_at: sub.expires_at,
      expected_expires_at: new Date(safeMs).toISOString(),
    }
  }

  const targetIso = new Date(safeMs).toISOString()
  const before = {
    status: sub?.status ?? null,
    expires_at: sub?.expires_at instanceof Date ? sub.expires_at.toISOString() : sub?.expires_at ?? null,
  }

  if (!dryRun) {
    const txnId = lastOrderId || String(sub?.transaction_id ?? `repair:restore:${d}`).slice(0, 240)
    await pool.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at)
       VALUES ($1, 'active', $2::timestamptz, COALESCE($3::timestamptz, now()), $4, now())
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = GREATEST(device_subscriptions.expires_at, EXCLUDED.expires_at),
         transaction_id = CASE
           WHEN EXCLUDED.expires_at >= device_subscriptions.expires_at THEN EXCLUDED.transaction_id
           ELSE device_subscriptions.transaction_id
         END,
         updated_at = now()`,
      [d, targetIso, sub?.started_at ?? null, txnId],
    )
    invalidateSubscriptionAccessCache(d)

    if (lastOrderId) {
      const txn = await getTransactionByOrderId(lastOrderId)
      if (txn && String(txn.status) === 'completed') {
        await tryActivateDeviceSubscriptionFromCompletedTxn(txn).catch(() => {})
      }
    }
  }

  return {
    restored: !dryRun,
    dry_run: dryRun,
    device_id: d,
    device_id_masked: maskId(d),
    before,
    after_expires_at: targetIso,
    expected_expires_at: expectedExpiresAt,
    last_payment_floor: floorIso,
    replay_steps: steps.length,
    would_restore: true,
  }
}

/**
 * @param {{ dryRun?: boolean; sinceDays?: number; maxRestores?: number; deviceId?: string }} opts
 */
export async function runSubscriptionExpiryRestore(opts = {}) {
  const dryRun = opts.dryRun !== false
  const sinceDays = Math.min(90, Math.max(1, Number(opts.sinceDays) || 30))
  const maxRestores = Math.min(500, Math.max(1, Number(opts.maxRestores) || 200))
  const deviceFilter = String(opts.deviceId ?? '').trim()
  const pool = requirePool()

  const report = {
    dry_run: dryRun,
    restored_at: new Date().toISOString(),
    victims_found: 0,
    migration_shadows_found: 0,
    restored_count: 0,
    migration_restored_count: 0,
    replay_restored_count: 0,
    orphan_finalized_count: 0,
    flagged_uncertain: [],
    restored: [],
    unresolved: [],
  }

  const shadows = deviceFilter
    ? (await findIncorrectlyRevokedMigrationShadows(pool)).filter((r) => String(r.device_id) === deviceFilter)
    : await findIncorrectlyRevokedMigrationShadows(pool)
  const transferReturns = deviceFilter
    ? (await findTransferSourceRestoreCandidates(pool)).filter((r) => String(r.target_device_id) === deviceFilter)
    : await findTransferSourceRestoreCandidates(pool)

  report.migration_shadows_found = shadows.length + transferReturns.length

  const transferReturnTargets = new Set(
    transferReturns.map((r) => String(r.target_device_id ?? '').trim()).filter(Boolean),
  )
  const protectedSources = new Set(transferReturnTargets)

  const pairMap = new Map()
  for (const row of transferReturns) {
    const target = String(row.target_device_id ?? '').trim()
    const source = String(row.source_device_id ?? '').trim()
    if (!target || !source) continue
    pairMap.set(target, { source, match_reason: 'transfer_source_return', priority: 3 })
  }
  for (const row of shadows) {
    const target = String(row.device_id ?? '').trim()
    const source = String(row.source_device_id ?? '').trim()
    if (!target || !source || pairMap.has(target)) continue
    if (protectedSources.has(source)) continue
    pairMap.set(target, { source, match_reason: row.match_reason || 'migration_shadow', priority: 2 })
  }

  const sortedPairs = [...pairMap.entries()].sort((a, b) => (b[1].priority || 0) - (a[1].priority || 0))

  for (const [target, { source, match_reason }] of sortedPairs) {
    if (report.restored_count >= maxRestores) break
    const before = await getDeviceSubscriptionAccessState(target, null)
    if (isActiveAccess(before)) continue

    if (!dryRun) {
      const mig = await migrateSubscriptionFromSourceDevice(target, source, null, {
        allowReverseTransfer: true,
        reason: 'expiry_incident_restore',
      })
      const after = await getDeviceSubscriptionAccessState(target, null)
      const ok = mig.recovered === true && isActiveAccess(after)
      const entry = {
        device_id: target,
        device_id_masked: maskId(target),
        method: 'migration_shadow',
        match_reason,
        source_device_id: source,
        recovered: ok,
        before_expires_at: before?.expires_at ?? null,
        after_expires_at: after?.expires_at ?? null,
      }
      if (ok) {
        report.restored_count += 1
        report.migration_restored_count += 1
        report.restored.push(entry)
      } else {
        report.unresolved.push({ ...entry, reason: mig.reason || 'migration_failed' })
      }
    } else {
      const srcAccess = await getDeviceSubscriptionAccessState(source, null)
      report.restored.push({
        device_id: target,
        device_id_masked: maskId(target),
        method: 'migration_shadow',
        match_reason,
        source_device_id: source,
        would_restore: isActiveAccess(srcAccess),
        source_expires_at: srcAccess?.expires_at ?? null,
        dry_run: true,
      })
      report.restored_count += 1
      report.migration_restored_count += 1
    }
  }

  let replayCandidates = await findPaymentReplayRestoreCandidates(pool, { sinceDays })
  if (deviceFilter) {
    replayCandidates = replayCandidates.filter((r) => r.device_id === deviceFilter)
  }
  report.victims_found = replayCandidates.length

  for (const row of replayCandidates) {
    if (report.replay_restored_count + report.migration_restored_count >= maxRestores) break
    const beforeAccess = await getDeviceSubscriptionAccessState(row.device_id, null)
    if (isActiveAccess(beforeAccess)) continue

    const result = await restoreDeviceSubscriptionFromReplay(row.device_id, { dryRun })
    if (result.would_restore || result.restored) {
      const afterAccess = dryRun ? null : await getDeviceSubscriptionAccessState(row.device_id, null)
      const ok = dryRun ? true : isActiveAccess(afterAccess)
      const entry = {
        ...result,
        category: row.category,
        method: 'payment_replay',
        active_after: ok,
      }
      if (ok) {
        report.replay_restored_count += 1
        report.restored_count += 1
        report.restored.push(entry)
      } else {
        report.unresolved.push({ ...entry, reason: result.reason || 'replay_restore_inactive' })
      }
    }
  }

  if (!deviceFilter) {
    const { rows: orphanRows } = await pool.query(
      `SELECT DISTINCT t.device_id::text AS device_id
       FROM transactions t
       WHERE t.status = 'completed'
         AND COALESCE(t.device_id, '') <> ''
         AND COALESCE(t.updated_at, t.created_at) > now() - ($1::int * interval '1 day')
         AND NOT EXISTS (
           SELECT 1 FROM device_subscriptions ds
           WHERE ds.device_id = t.device_id
             AND ds.status = 'active'
             AND ds.expires_at > now()
         )
       LIMIT 100`,
      [sinceDays],
    )
    for (const row of orphanRows) {
      if (report.restored_count >= maxRestores) break
      const deviceId = String(row.device_id || '').trim()
      if (!deviceId) continue
      const access = await getDeviceSubscriptionAccessState(deviceId, null)
      if (isActiveAccess(access)) continue
      if (!dryRun) {
        const fin = await tryFinalizeActivationForDevice(deviceId)
        const after = await getDeviceSubscriptionAccessState(deviceId, null)
        if (isActiveAccess(after)) {
          report.orphan_finalized_count += 1
          report.restored_count += 1
          report.restored.push({
            device_id: deviceId,
            method: 'orphan_finalize',
            activated: fin.activated === true,
            after_expires_at: after?.expires_at ?? null,
          })
        }
      }
    }
  }

  report.ok = report.unresolved.length === 0
  return report
}
