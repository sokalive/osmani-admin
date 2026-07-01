/**
 * Full subscription API / DB / admin parity audit + repair.
 * Finds future entitlement shown inactive on any API surface.
 */
import { getPool } from '../db/pool.js'
import { getDeviceSubscriptionAccessStateFast } from '../billingStore.js'
import { repairFalseExpiredSubscriptions, findFalseExpiredSubscriptions } from './subscriptionFalseExpiredRepair.js'
import {
  findWrongDirectionMigrationVictims,
  repairWrongDirectionMigrations,
  countDeniedFutureEntitlement,
} from './subscriptionWrongDirectionRepair.js'
import { runDirectShadowRepairBatch } from './subscriptionShadowRepairBatch.js'
import { migrateSubscriptionFromSourceDevice } from './subscriptionRecovery.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { findIncorrectlyRevokedMigrationShadows } from './subscriptionIncidentAudit.js'
import { runSubscriptionRestorationAudit } from './subscriptionRestorationAudit.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function phoneDigitsSql(expr) {
  return `regexp_replace(COALESCE(${expr}::text, ''), '[^0-9]', '', 'g')`
}

async function loadLegitimateTransferSourceIds(pool) {
  const { rows } = await pool.query(
    `SELECT DISTINCT dt.source_device_id::text AS device_id
     FROM device_transfers dt
     INNER JOIN device_subscriptions ds_tgt
       ON ds_tgt.device_id = dt.target_device_id
      AND ds_tgt.status = 'active'
      AND ds_tgt.expires_at > now()
     WHERE dt.status = 'completed'
       AND trim(coalesce(dt.source_device_id::text, '')) <> ''`,
  )
  return new Set(rows.map((r) => String(r.device_id)))
}

/** Phones with more than one concurrently active subscription (must consolidate). */
export async function findDuplicateActivePhoneClusters(pool = requirePool()) {
  const { rows } = await pool.query(
    `WITH active_devices AS (
       SELECT ds.device_id::text AS device_id,
              ds.expires_at,
              ds.started_at,
              ds.transaction_id,
              ds.status,
              ${phoneDigitsSql('t.phone')} AS phone_digits
       FROM device_subscriptions ds
       INNER JOIN transactions t
         ON t.device_id = ds.device_id
        AND t.status = 'completed'
        AND trim(coalesce(t.phone::text, '')) <> ''
       WHERE ds.status = 'active'
         AND ds.expires_at > now()
         AND length(${phoneDigitsSql('t.phone')}) >= 10
     ),
     clusters AS (
       SELECT phone_digits,
              COUNT(DISTINCT device_id)::int AS active_count
       FROM active_devices
       GROUP BY phone_digits
       HAVING COUNT(DISTINCT device_id) > 1
     )
     SELECT ad.phone_digits,
            ad.device_id,
            ad.expires_at,
            ad.started_at,
            ad.transaction_id
     FROM active_devices ad
     INNER JOIN clusters c ON c.phone_digits = ad.phone_digits
     ORDER BY ad.phone_digits, ad.expires_at DESC`,
  )
  const byPhone = new Map()
  for (const row of rows) {
    const phone = String(row.phone_digits)
    if (!byPhone.has(phone)) byPhone.set(phone, [])
    byPhone.get(phone).push(row)
  }
  return [...byPhone.entries()].map(([phone_digits, devices]) => ({
    phone_digits,
    devices,
    active_count: devices.length,
  }))
}

async function resolveCanonicalDeviceForPhone(pool, phoneDigits) {
  const digits = String(phoneDigits ?? '').trim()
  if (digits.length < 10) return null
  const { rows } = await pool.query(
    `WITH linked AS (
       SELECT DISTINCT device_id::text AS device_id
       FROM transactions
       WHERE status = 'completed' AND ${phoneDigitsSql('phone')} = $1
       UNION
       SELECT DISTINCT device_id::text FROM device_phone_registry WHERE phone_number_normalized = $1
     ),
     scored AS (
       SELECT l.device_id,
              (SELECT MAX(tel.created_at) FROM client_api_telemetry tel
               WHERE tel.device_id = l.device_id
                 AND tel.created_at > now() - interval '14 days') AS last_telemetry,
              length(l.device_id) AS id_len
       FROM linked l
     )
     SELECT device_id FROM scored
     ORDER BY (last_telemetry IS NOT NULL) DESC, last_telemetry DESC NULLS LAST, id_len ASC, device_id ASC
     LIMIT 1`,
    [digits],
  )
  return rows[0]?.device_id ? String(rows[0].device_id) : null
}

async function probeApiParity(deviceId) {
  const row = await getDeviceSubscriptionAccessStateFast(deviceId)
  if (!row) {
    return {
      device_id: deviceId,
      db_row: false,
      status_api_active: false,
      verify_would_active: false,
      admin_would_active: false,
      mismatch: true,
      reason: 'no_subscription_row',
    }
  }
  const future = row.expires_at && new Date(row.expires_at).getTime() > Date.now()
  const statusActive = row.active_now === true && row.blocked_now !== true
  const verifyWouldActive =
    future &&
    String(row.status ?? '').toLowerCase() === 'active' &&
    row.blocked_now !== true
  const adminWouldActive = String(row.status ?? '').toLowerCase() === 'active' && future
  const entitledButDenied =
    future &&
    !statusActive &&
    !String(row.transaction_id ?? '').startsWith('moved:')
  return {
    device_id: deviceId,
    db_row: true,
    status: row.status,
    expires_at: row.expires_at,
    transaction_id: row.transaction_id,
    status_api_active: statusActive,
    verify_would_active: verifyWouldActive,
    admin_would_active: adminWouldActive,
    mismatch:
      entitledButDenied ||
      (future && statusActive !== verifyWouldActive) ||
      (future && adminWouldActive !== statusActive),
    reason: entitledButDenied ? 'entitled_but_denied' : statusActive !== verifyWouldActive ? 'api_internal' : null,
  }
}

/**
 * Scan subscriptions with future expiry where APIs/admin would not show ACTIVE.
 */
export async function runSubscriptionApiParityAudit(pool = requirePool()) {
  const transferSources = await loadLegitimateTransferSourceIds(pool)
  const falseExpired = await findFalseExpiredSubscriptions(pool)
  const wrongDirection = await findWrongDirectionMigrationVictims(pool)
  const shadows = await findIncorrectlyRevokedMigrationShadows(pool, { requireTelemetry: false })
  const duplicates = await findDuplicateActivePhoneClusters(pool)
  const denied = await countDeniedFutureEntitlement(pool)
  const restoration = await runSubscriptionRestorationAudit({ repair: false, skipAutoLink: true })

  const { rows: entitledRows } = await pool.query(
    `SELECT device_id::text AS device_id
     FROM device_subscriptions
     WHERE expires_at > now()
       AND status <> 'active'
       AND COALESCE(transaction_id, '') NOT LIKE 'moved:%'
       AND COALESCE(manual_admin_blocked, false) = false
     ORDER BY expires_at DESC
     LIMIT 500`,
  )

  const apiProbes = []
  for (const row of entitledRows.slice(0, 100)) {
    const deviceId = String(row.device_id)
    if (transferSources.has(deviceId)) continue
    apiProbes.push(await probeApiParity(deviceId))
  }

  const apiMismatch = apiProbes.filter((p) => p.mismatch)
  const duplicateDeviceCount = duplicates.reduce((n, c) => n + Math.max(0, c.active_count - 1), 0)
  const entitledActionable = entitledRows.filter((r) => !transferSources.has(String(r.device_id)))

  return {
    server_time: new Date().toISOString(),
    counts: {
      false_expired: falseExpired.affected_count,
      wrong_direction_victims: wrongDirection.length,
      migration_shadows: shadows.length,
      restoration_unresolved: restoration.unresolved_users_count,
      duplicate_phone_active_excess: duplicateDeviceCount,
      duplicate_phone_clusters: duplicates.length,
      entitled_non_active_non_moved: entitledActionable.length,
      entitled_transfer_sources_skipped: entitledRows.length - entitledActionable.length,
      api_mismatch_sampled: apiMismatch.length,
      denied_future_total: denied.total_denied_future,
      active_subscriptions: restoration.total_active_subscriptions,
    },
    false_expired: falseExpired.affected,
    wrong_direction: wrongDirection.slice(0, 50),
    duplicate_clusters: duplicates.slice(0, 30),
    api_mismatch: apiMismatch,
    restoration_unresolved: restoration.unresolved.slice(0, 50),
  }
}

/**
 * Consolidate multiple active subs on same phone onto canonical device (longest expiry wins).
 */
export async function repairDuplicatePhoneClusters(opts = {}) {
  const dryRun = opts.dryRun !== false
  const confirm = opts.confirm === true
  const pool = requirePool()
  const clusters = await findDuplicateActivePhoneClusters(pool)
  const repaired = []
  const failed = []

  for (const cluster of clusters) {
    const canonical = await resolveCanonicalDeviceForPhone(pool, cluster.phone_digits)
    if (!canonical) continue
    const sorted = [...cluster.devices].sort(
      (a, b) => new Date(b.expires_at).getTime() - new Date(a.expires_at).getTime(),
    )
    const bestDevice = String(sorted[0].device_id)
    if (dryRun) {
      repaired.push({
        action: 'would_consolidate',
        canonical,
        best_source: bestDevice,
        expires_at: sorted[0].expires_at,
        phone: cluster.phone_digits,
        duplicate_devices: sorted.map((d) => d.device_id),
      })
      continue
    }
    if (!confirm) continue
    try {
      if (bestDevice !== canonical) {
        const mig = await migrateSubscriptionFromSourceDevice(canonical, bestDevice, null, {
          allowRevokedTarget: true,
        })
        if (!mig.recovered) {
          failed.push({ canonical, from: bestDevice, error: mig.reason || 'not_recovered' })
          continue
        }
      }
      for (const dev of sorted) {
        const other = String(dev.device_id)
        if (other === canonical) continue
        const row = await getDeviceSubscriptionAccessStateFast(other)
        if (row?.active_now === true) {
          await migrateSubscriptionFromSourceDevice(canonical, other, null, { allowRevokedTarget: true })
        }
        invalidateSubscriptionAccessCache(other)
      }
      invalidateSubscriptionAccessCache(canonical)
      repaired.push({
        action: 'consolidated',
        canonical,
        best_source: bestDevice,
        phone: cluster.phone_digits,
      })
    } catch (e) {
      failed.push({ canonical, error: String(e.message || e) })
    }
  }

  const remaining = (await findDuplicateActivePhoneClusters(pool)).length
  return { dry_run: dryRun, repaired_count: repaired.length, repaired, failed, remaining_clusters: remaining }
}

/**
 * Run all repair pipelines until counters reach zero (bounded rounds).
 */
export async function runFullSubscriptionParityRepair(opts = {}) {
  const confirm = opts.confirm === true
  const maxRounds = Math.max(1, Math.min(20, Number(opts.maxRounds) || 10))
  const rounds = []
  let before = await runSubscriptionApiParityAudit()

  for (let i = 0; i < maxRounds; i++) {
    const round = { round: i + 1, steps: {} }
    if (confirm) {
      round.steps.false_expired = await repairFalseExpiredSubscriptions({ dryRun: false, confirm: true })
      round.steps.wrong_direction = await repairWrongDirectionMigrations({
        dryRun: false,
        confirm: true,
        limit: 50,
      })
      round.steps.duplicate_phone = await repairDuplicatePhoneClusters({ dryRun: false, confirm: true })
      round.steps.shadow = await runDirectShadowRepairBatch({ shadowLimit: 25, orphanLimit: 10 })
    }
    const after = await runSubscriptionApiParityAudit()
    round.counts_after = after.counts
    rounds.push(round)
    const done =
      after.counts.false_expired === 0 &&
      after.counts.wrong_direction_victims === 0 &&
      after.counts.migration_shadows === 0 &&
      after.counts.restoration_unresolved === 0 &&
      after.counts.duplicate_phone_clusters === 0 &&
      after.counts.entitled_non_active_non_moved === 0
    if (done) break
    if (confirm && i > 0) {
      const prev = rounds[rounds.length - 2]?.counts_after
      const curr = after.counts
      const progressed =
        (prev?.false_expired ?? 0) > (curr.false_expired ?? 0) ||
        (prev?.wrong_direction_victims ?? 0) > (curr.wrong_direction_victims ?? 0) ||
        (prev?.duplicate_phone_clusters ?? 0) > (curr.duplicate_phone_clusters ?? 0)
      if (!progressed) break
    }
  }

  const after = await runSubscriptionApiParityAudit()
  return {
    ok:
      after.counts.false_expired === 0 &&
      after.counts.wrong_direction_victims === 0 &&
      after.counts.migration_shadows === 0 &&
      after.counts.restoration_unresolved === 0 &&
    after.counts.duplicate_phone_clusters === 0 &&
    after.counts.entitled_non_active_non_moved === 0 &&
    after.counts.api_mismatch_sampled === 0 &&
      after.counts.api_mismatch_sampled === 0,
    before: before.counts,
    after: after.counts,
    rounds,
    audit: after,
  }
}
