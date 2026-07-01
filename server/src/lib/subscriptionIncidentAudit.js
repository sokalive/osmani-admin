/**
 * Production incident audit: paid users wrongly denied access (revoked/suspended/migration shadow).
 */
import { getPool } from '../db/pool.js'
import { getDeviceSubscriptionAccessState } from '../billingStore.js'
import { runSubscriptionRestorationAudit } from './subscriptionRestorationAudit.js'
import { reconcileUnblockedPlaybackAccess } from './deviceSecurityPlaybackAudit.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

/** Active paid rows with manual_admin_blocked=true (incorrectly suspended). */
export async function findIncorrectlySuspendedActive(pool = requirePool()) {
  const { rows } = await pool.query(
    `SELECT ds.device_id::text AS device_id,
            ds.expires_at,
            ds.transaction_id,
            ds.started_at,
            ds.manual_admin_blocked,
            ir.status AS intelligence_status
     FROM device_subscriptions ds
     LEFT JOIN device_intelligence_registry ir ON ir.device_id = ds.device_id
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND (
         ds.manual_admin_blocked = true
         OR ir.status = 'blocked'
       )
     ORDER BY ds.expires_at DESC`,
  )
  return rows
}

/**
 * Device has no active sub but shares install/phone/fingerprint with another device that does
 * (incorrectly revoked on this device_id).
 */
export async function findIncorrectlyRevokedMigrationShadows(
  pool = requirePool(),
  { requireTelemetry = true } = {},
) {
  const telemetryClause = requireTelemetry
    ? `AND EXISTS (
       SELECT 1 FROM client_api_telemetry tel
       WHERE tel.device_id = shadow.shadow_device_id
         AND tel.created_at > now() - interval '14 days'
     )`
    : ''
  const { rows } = await pool.query(
    `WITH shadow AS (
       SELECT DISTINCT shadow_device_id, source_device_id, match_reason
       FROM (
         SELECT dte_new.device_id AS shadow_device_id,
                ds_source.device_id AS source_device_id,
                'fingerprint_trial_shadow' AS match_reason
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
         UNION ALL
         SELECT ai_new.device_id::text,
                ds_source.device_id::text,
                'install_instance_shadow'
         FROM app_installs ai_new
         INNER JOIN app_installs ai_src
           ON ai_src.install_instance_id = ai_new.install_instance_id
          AND trim(ai_src.install_instance_id) <> ''
          AND ai_src.device_id <> ai_new.device_id
         INNER JOIN device_subscriptions ds_source
           ON ds_source.device_id = ai_src.device_id
          AND ds_source.status = 'active'
          AND ds_source.expires_at > now()
         LEFT JOIN device_subscriptions ds_new
           ON ds_new.device_id = ai_new.device_id
          AND ds_new.status = 'active'
          AND ds_new.expires_at > now()
         WHERE ds_new.device_id IS NULL
         UNION ALL
         SELECT t_new.device_id::text,
                ds_source.device_id::text,
                'payment_phone_shadow'
         FROM device_subscriptions ds_source
         INNER JOIN transactions t_source
           ON t_source.device_id = ds_source.device_id
          AND t_source.status = 'completed'
          AND trim(coalesce(t_source.phone::text, '')) <> ''
         INNER JOIN transactions t_new
           ON t_new.device_id <> ds_source.device_id
          AND trim(coalesce(t_new.phone::text, '')) <> ''
          AND regexp_replace(coalesce(t_new.phone::text, ''), '[^0-9]', '', 'g') =
              regexp_replace(coalesce(t_source.phone::text, ''), '[^0-9]', '', 'g')
         LEFT JOIN device_subscriptions ds_new
           ON ds_new.device_id = t_new.device_id
          AND ds_new.status = 'active'
          AND ds_new.expires_at > now()
         WHERE ds_source.status = 'active'
           AND ds_source.expires_at > now()
           AND ds_new.device_id IS NULL
         UNION ALL
         SELECT dpr_new.device_id::text,
                ds_source.device_id::text,
                'payment_phone_shadow'
         FROM device_subscriptions ds_source
         INNER JOIN device_phone_registry dpr_src
           ON dpr_src.device_id = ds_source.device_id
          AND trim(dpr_src.phone_number_normalized) <> ''
         INNER JOIN device_phone_registry dpr_new
           ON dpr_new.phone_number_normalized = dpr_src.phone_number_normalized
          AND dpr_new.device_id <> ds_source.device_id
         LEFT JOIN device_subscriptions ds_new
           ON ds_new.device_id = dpr_new.device_id
          AND ds_new.status = 'active'
          AND ds_new.expires_at > now()
         WHERE ds_source.status = 'active'
           AND ds_source.expires_at > now()
           AND ds_new.device_id IS NULL
       ) u
     )
     SELECT shadow_device_id AS device_id,
            source_device_id,
            match_reason,
            ds_src.expires_at AS source_expires_at
     FROM shadow
     INNER JOIN device_subscriptions ds_src
       ON ds_src.device_id = shadow.source_device_id
     WHERE NOT EXISTS (
       SELECT 1 FROM device_subscriptions ds_ok
       WHERE ds_ok.device_id = shadow.shadow_device_id
         AND ds_ok.status = 'active'
         AND ds_ok.expires_at > now()
     )
     AND NOT EXISTS (
       SELECT 1 FROM device_subscriptions ds_rev
       WHERE ds_rev.device_id = shadow.shadow_device_id
         AND COALESCE(ds_rev.transaction_id, '') LIKE 'moved:%'
     )
     AND NOT EXISTS (
       SELECT 1 FROM device_transfers dt
       WHERE dt.status = 'completed'
         AND dt.source_device_id = shadow.shadow_device_id
     )
     ${telemetryClause}
     ORDER BY shadow_device_id`,
  )
  return rows
}

async function hostLabelForDevices(pool, deviceIds) {
  const ids = [...new Set(deviceIds.map((d) => String(d || '').trim()).filter(Boolean))]
  if (!ids.length) return new Map()
  const { rows } = await pool.query(
    `SELECT device_id,
            host_label,
            COUNT(*)::int AS hits
     FROM client_api_telemetry
     WHERE device_id = ANY($1::text[])
       AND created_at > now() - interval '14 days'
     GROUP BY device_id, host_label`,
    [ids],
  )
  const byDevice = new Map()
  for (const row of rows) {
    const d = String(row.device_id)
    const prev = byDevice.get(d) || { vps: 0, render: 0, unknown: 0 }
    const label = String(row.host_label || '').toLowerCase()
    const hits = Number(row.hits) || 0
    if (label === 'vps') prev.vps += hits
    else if (label === 'render') prev.render += hits
    else prev.unknown += hits
    byDevice.set(d, prev)
  }
  const out = new Map()
  for (const [d, counts] of byDevice) {
    const total = counts.vps + counts.render + counts.unknown
    let host = 'unknown'
    if (total > 0) {
      if (counts.vps >= counts.render && counts.vps > 0) host = 'vps'
      else if (counts.render > counts.vps) host = 'render'
      else if (counts.vps > 0) host = 'vps'
      else if (counts.render > 0) host = 'render'
    }
    out.set(d, host)
  }
  return out
}

async function probeVerifyAccess(deviceId) {
  const row = await getDeviceSubscriptionAccessState(deviceId, null)
  return {
    device_id: deviceId,
    active_now: row?.active_now === true && row?.blocked_now !== true,
    blocked_now: row?.blocked_now === true,
    status: row?.status ?? null,
    expires_at: row?.expires_at ?? null,
  }
}

/**
 * @param {{ repair?: boolean, reconcileBlocks?: boolean }} opts
 */
export async function runSubscriptionIncidentAudit(opts = {}) {
  const repair = opts.repair === true
  const reconcileBlocks = opts.reconcileBlocks !== false
  const skipSlowAutoLink = opts.skipSlowAutoLink !== false
  const pool = requirePool()

  const before = {
    total_active_subscriptions: (
      await pool.query(
        `SELECT COUNT(*)::int AS n FROM device_subscriptions
         WHERE status = 'active' AND expires_at > now()`,
      )
    ).rows[0]?.n ?? 0,
    incorrectly_suspended: [],
    incorrectly_revoked_shadows: [],
    restoration: null,
    reconcile: null,
  }

  before.incorrectly_suspended = await findIncorrectlySuspendedActive(pool)
  before.incorrectly_revoked_shadows = await findIncorrectlyRevokedMigrationShadows(pool)

  const affectedDeviceIds = [
    ...before.incorrectly_suspended.map((r) => r.device_id),
    ...before.incorrectly_revoked_shadows.map((r) => r.device_id),
  ]
  const hostMap = await hostLabelForDevices(pool, affectedDeviceIds)

  const renderAffected = new Set()
  const vpsAffected = new Set()
  for (const id of affectedDeviceIds) {
    const h = hostMap.get(id) || 'unknown'
    if (h === 'render') renderAffected.add(id)
    else if (h === 'vps') vpsAffected.add(id)
  }

  let restorationReport = null
  let reconcileReport = null
  if (repair) {
    if (reconcileBlocks && before.incorrectly_suspended.length > 0) {
      reconcileReport = await reconcileUnblockedPlaybackAccess({ emitUpdates: true })
    }
    restorationReport = await runSubscriptionRestorationAudit({
      repair: true,
      skipAutoLink: skipSlowAutoLink,
    })
  } else {
    restorationReport = await runSubscriptionRestorationAudit({ repair: false })
  }

  const afterSuspended = await findIncorrectlySuspendedActive(pool)
  const afterShadows = await findIncorrectlyRevokedMigrationShadows(pool)

  const recovered = []
  if (repair) {
    for (const row of before.incorrectly_revoked_shadows) {
      const probe = await probeVerifyAccess(row.device_id)
      if (probe.active_now) {
        recovered.push({
          device_id: row.device_id,
          source_device_id: row.source_device_id,
          match_reason: row.match_reason,
          host: hostMap.get(row.device_id) || 'unknown',
        })
      }
    }
  }

  const report = {
    ok: afterSuspended.length === 0 && afterShadows.length === 0 && (restorationReport?.unresolved_users_count ?? 0) === 0,
    server_time: new Date().toISOString(),
    counts: {
      total_affected_users:
        before.incorrectly_suspended.length + before.incorrectly_revoked_shadows.length,
      incorrectly_suspended_active: before.incorrectly_suspended.length,
      incorrectly_revoked_migration_shadow: before.incorrectly_revoked_shadows.length,
      render_users_affected: renderAffected.size,
      vps_users_affected: vpsAffected.size,
      restoration_affected: restorationReport?.affected_users_count ?? 0,
      restoration_unresolved: restorationReport?.unresolved_users_count ?? 0,
    },
    before: {
      incorrectly_suspended_active: before.incorrectly_suspended.length,
      incorrectly_revoked_migration_shadow: before.incorrectly_revoked_shadows.length,
      total_active_subscriptions: before.total_active_subscriptions,
      suspended_devices: before.incorrectly_suspended,
      revoked_shadow_devices: before.incorrectly_revoked_shadows,
    },
    after: {
      incorrectly_suspended_active: afterSuspended.length,
      incorrectly_revoked_migration_shadow: afterShadows.length,
      total_active_subscriptions: (
        await pool.query(
          `SELECT COUNT(*)::int AS n FROM device_subscriptions
           WHERE status = 'active' AND expires_at > now()`,
        )
      ).rows[0]?.n ?? 0,
      suspended_devices: afterSuspended,
      revoked_shadow_devices: afterShadows,
    },
    recovered_users: recovered,
    restoration: restorationReport,
    reconcile: reconcileReport,
    host_attribution: Object.fromEntries(hostMap),
    root_cause_summary: [
      'Render startup crash (cache invalidation loop + process.exit) caused HTTP 502 during deploy windows.',
      'Verify errors could return transient inactive (active=false, blocked=false) — client shows Kifurushi kimezuiwa.',
      'VPS/APK reinstall migration shadows: active sub on old device_id, new device_id unlinked (revoked shape).',
      'SSE subscription-stream never writes revoked; device_subscription triggers verify refresh only.',
      'Cache pressure fallback cannot downgrade fingerprinted or cached-active users (verifyDbResilience guards).',
    ],
    verification_queries: {
      suspended_active:
        "SELECT device_id FROM device_subscriptions WHERE status='active' AND expires_at > now() AND manual_admin_blocked = true",
      migration_shadow_install:
        'See findMigrationShadowByInstallInstance in subscriptionRestorationAudit.js',
      restoration_audit: 'GET /api/runtime/subscription-restoration-audit',
    },
  }

  return report
}
