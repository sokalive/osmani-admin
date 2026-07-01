/**
 * Repair subscriptions migrated OFF the user's current device_id (wrong direction).
 * Victim rows have transaction_id moved:* while a sibling on the same payment phone
 * still holds the active subscription the user should have on this device.
 */
import { getPool } from '../db/pool.js'
import { getDeviceSubscriptionAccessStateFast } from '../billingStore.js'
import { migrateSubscriptionFromSourceDevice } from './subscriptionRecovery.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { isCompletedTransferSourceDevice } from './transferRevocationGuard.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function phoneDigitsSql(expr) {
  return `regexp_replace(COALESCE(${expr}::text, ''), '[^0-9]', '', 'g')`
}

/** Best device_id to own the subscription for this payment phone (VPS/telemetry wins over legacy hash). */
async function resolveCanonicalDeviceForPhone(pool, phoneDigits) {
  const digits = String(phoneDigits ?? '').trim()
  if (digits.length < 10) return null
  const { rows } = await pool.query(
    `WITH linked AS (
       SELECT DISTINCT device_id::text AS device_id
       FROM transactions
       WHERE status = 'completed'
         AND ${phoneDigitsSql('phone')} = $1
       UNION
       SELECT DISTINCT device_id::text
       FROM device_phone_registry
       WHERE phone_number_normalized = $1
     ),
     scored AS (
       SELECT l.device_id,
              (SELECT MAX(tel.created_at) FROM client_api_telemetry tel
               WHERE tel.device_id = l.device_id
                 AND tel.created_at > now() - interval '14 days') AS last_telemetry,
              length(l.device_id) AS id_len
       FROM linked l
     )
     SELECT device_id
     FROM scored
     ORDER BY (last_telemetry IS NOT NULL) DESC,
              last_telemetry DESC NULLS LAST,
              id_len ASC,
              device_id ASC
     LIMIT 1`,
    [digits],
  )
  return rows[0]?.device_id ? String(rows[0].device_id) : null
}

/**
 * Devices with moved:* revoke that still use the app but lost active sub to a phone sibling.
 */
export async function findWrongDirectionMigrationVictims(pool = requirePool()) {
  const { rows } = await pool.query(
    `WITH victims AS (
       SELECT ds.device_id::text AS victim_device_id,
              ds.expires_at AS victim_expires_at,
              ds.transaction_id AS victim_transaction_id,
              ds.started_at AS victim_started_at
       FROM device_subscriptions ds
       WHERE COALESCE(ds.transaction_id, '') LIKE 'moved:%'
         AND ds.status <> 'active'
         AND ds.expires_at > now()
     ),
     victim_phones AS (
       SELECT DISTINCT v.victim_device_id, ${phoneDigitsSql('t.phone')} AS phone_digits
       FROM victims v
       INNER JOIN transactions t
         ON t.device_id = v.victim_device_id
        AND t.status = 'completed'
        AND trim(coalesce(t.phone::text, '')) <> ''
       WHERE length(${phoneDigitsSql('t.phone')}) >= 10
       UNION
       SELECT DISTINCT v.victim_device_id, dpr.phone_number_normalized AS phone_digits
       FROM victims v
       INNER JOIN device_phone_registry dpr
         ON dpr.device_id = v.victim_device_id
        AND trim(dpr.phone_number_normalized) <> ''
     ),
     phone_siblings AS (
       SELECT DISTINCT vp.victim_device_id, t2.device_id::text AS sibling_device_id
       FROM victim_phones vp
       INNER JOIN transactions t2
         ON t2.status = 'completed'
        AND ${phoneDigitsSql('t2.phone')} = vp.phone_digits
        AND t2.device_id::text <> vp.victim_device_id
       UNION
       SELECT DISTINCT vp.victim_device_id, dpr2.device_id::text
       FROM victim_phones vp
       INNER JOIN device_phone_registry dpr2
         ON dpr2.phone_number_normalized = vp.phone_digits
        AND dpr2.device_id <> vp.victim_device_id
     ),
     ranked AS (
       SELECT v.victim_device_id,
              v.victim_expires_at,
              v.victim_transaction_id,
              ds_src.device_id::text AS source_device_id,
              ds_src.expires_at AS source_expires_at,
              ds_src.transaction_id AS source_transaction_id,
              ds_src.started_at AS source_started_at,
              ROW_NUMBER() OVER (
                PARTITION BY v.victim_device_id
                ORDER BY ds_src.expires_at DESC, ds_src.updated_at DESC
              ) AS rn
       FROM victims v
       INNER JOIN phone_siblings ps ON ps.victim_device_id = v.victim_device_id
       INNER JOIN device_subscriptions ds_src
         ON ds_src.device_id = ps.sibling_device_id
        AND ds_src.status = 'active'
        AND ds_src.expires_at > now()
       WHERE NOT EXISTS (
         SELECT 1 FROM device_transfers dt
         WHERE dt.status = 'completed'
           AND dt.source_device_id = v.victim_device_id
           AND dt.target_device_id = ds_src.device_id
       )
     )
     SELECT victim_device_id,
            victim_expires_at,
            victim_transaction_id,
            source_device_id,
            source_expires_at,
            source_transaction_id,
            source_started_at
     FROM ranked
     WHERE rn = 1
     ORDER BY victim_device_id`,
  )

  const out = []
  for (const row of rows) {
    const victim = String(row.victim_device_id || '').trim()
    if (!victim) continue
    const { rows: phoneRows } = await pool.query(
      `SELECT DISTINCT ${phoneDigitsSql('t.phone')} AS phone_digits
       FROM transactions t
       WHERE t.device_id = $1 AND t.status = 'completed' AND trim(coalesce(t.phone::text,'')) <> ''
       UNION
       SELECT DISTINCT phone_number_normalized FROM device_phone_registry WHERE device_id = $1`,
      [victim],
    )
    let isCanonical = phoneRows.length > 0
    for (const pr of phoneRows) {
      const digits = String(pr.phone_digits ?? '').trim()
      if (digits.length < 10) continue
      const pick = await resolveCanonicalDeviceForPhone(pool, digits)
      if (pick && pick !== victim) {
        isCanonical = false
        break
      }
    }
    if (isCanonical) out.push(row)
  }
  return out
}

/** All future-expiry rows shown EXPIRED (non-active), including moved:* victims. */
export async function countDeniedFutureEntitlement(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE COALESCE(transaction_id, '') NOT LIKE 'moved:%')::int AS false_expired,
       COUNT(*) FILTER (WHERE COALESCE(transaction_id, '') LIKE 'moved:%')::int AS wrong_direction_moved,
       COUNT(*)::int AS total_denied_future
     FROM device_subscriptions
     WHERE expires_at > now()
       AND status <> 'active'
       AND COALESCE(manual_admin_blocked, false) = false`,
  )
  return rows[0] ?? { false_expired: 0, wrong_direction_moved: 0, total_denied_future: 0 }
}

async function probeActive(deviceId) {
  const row = await getDeviceSubscriptionAccessStateFast(deviceId)
  return row?.active_now === true && row?.blocked_now !== true
}

/**
 * @param {{ dryRun?: boolean; confirm?: boolean; limit?: number }} opts
 */
export async function repairWrongDirectionMigrations(opts = {}) {
  const dryRun = opts.dryRun !== false
  const confirm = opts.confirm === true
  const limit = Math.max(1, Math.min(100, Number(opts.limit) || 50))
  if (!dryRun && !confirm) {
    return { dry_run: true, error: 'Live repair requires dryRun=false and confirm=true', repaired_count: 0 }
  }

  const pool = requirePool()
  const beforeCounts = await countDeniedFutureEntitlement(pool)
  const victims = (await findWrongDirectionMigrationVictims(pool)).slice(0, limit)
  const repaired = []
  const failed = []
  const skipped = []

  for (const row of victims) {
    const target = String(row.victim_device_id || '').trim()
    const source = String(row.source_device_id || '').trim()
    if (!target || !source || target === source) continue
    if (await isCompletedTransferSourceDevice(target)) {
      skipped.push({ device_id: target, source_device_id: source, reason: 'completed_transfer_source' })
      continue
    }
    if (await probeActive(target)) {
      skipped.push({ device_id: target, source_device_id: source, reason: 'already_active' })
      continue
    }
    if (dryRun) {
      repaired.push({
        device_id: target,
        source_device_id: source,
        would_copy_expires_at: row.source_expires_at,
        would_copy_started_at: row.source_started_at,
        dry_run: true,
      })
      continue
    }
    try {
      const mig = await migrateSubscriptionFromSourceDevice(target, source, null, {
        allowRevokedTarget: true,
      })
      if (mig.recovered) {
        invalidateSubscriptionAccessCache(target)
        invalidateSubscriptionAccessCache(source)
        repaired.push({
          device_id: target,
          source_device_id: source,
          verify_active: await probeActive(target),
          ...mig,
        })
      } else {
        failed.push({ device_id: target, source_device_id: source, error: mig.reason || 'not_recovered' })
      }
    } catch (e) {
      failed.push({ device_id: target, source_device_id: source, error: String(e.message || e) })
    }
  }

  const afterCounts = dryRun ? beforeCounts : await countDeniedFutureEntitlement(pool)
  const remainingVictims = dryRun
    ? victims.length
    : (await findWrongDirectionMigrationVictims(pool)).length

  return {
    ok: remainingVictims === 0 && failed.length === 0,
    dry_run: dryRun,
    before: beforeCounts,
    after: afterCounts,
    victims_found: victims.length,
    remaining_victims: remainingVictims,
    repaired_count: repaired.length,
    repaired,
    failed,
    skipped,
  }
}
