import { getDeviceSubscriptionAccessState, setManualAdminBlocked } from '../billingStore.js'
import { getPool } from '../db/pool.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { unblockDeviceIntelligenceByDeviceId } from './deviceIntelligenceStore.js'
import {
  ensureDeviceSecurityTables,
  getPlaybackSecurityPolicy,
  resolveSmartMonitorSecurityLevel,
} from './deviceSecurityStore.js'

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

/** Ordered playback denial layers (first match wins). */
export const PLAYBACK_DENIAL_LAYERS = [
  'emergency_mode',
  'maintenance_mode',
  'manual_admin_blocked',
  'intelligence_blocked',
  'admin_devices_blocked',
  'profile_blocked',
  'security_level_blocked',
  'security_strict_monitoring',
  'subscription_blocked_now',
  'subscription_inactive',
  'none',
]

function classifyDenialLayer(row, policy, access, modes = {}) {
  if (modes.emergency_mode) return 'emergency_mode'
  if (modes.maintenance_mode) return 'maintenance_mode'
  if (row.manual_admin_blocked === true) return 'manual_admin_blocked'
  if (row.intelligence_status === 'blocked') return 'intelligence_blocked'
  if (row.admin_devices_blocked === true) return 'admin_devices_blocked'
  if (row.profile_blocked === true) return 'profile_blocked'
  if (policy?.deny_playback === true) {
    const adminStatus = String(row.admin_status || '')
    if (adminStatus === 'smart_monitor' || adminStatus === 'allowed') {
      if (String(row.security_level || '') === 'blocked' || String(row.security_level || '') === 'critical') {
        return 'security_level_blocked'
      }
    }
    return 'security_strict_monitoring'
  }
  if (access?.blocked_now === true) return 'subscription_blocked_now'
  if (access?.active_now !== true) return 'subscription_inactive'
  return 'none'
}

async function loadGlobalModes(pool) {
  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = 'emergency_mode' OR key = 'maintenance_mode' OR key = 'free_mode'`,
  ).catch(() => ({ rows: [] }))
  void rows
  try {
    const { loadGlobalAppModesPayload } = await import('../routes/globalAppSettings.js')
    const payload = await loadGlobalAppModesPayload()
    return {
      emergency_mode: payload?.emergency_mode === true,
      maintenance_mode: payload?.maintenance_mode === true,
      free_mode: payload?.free_mode === true,
    }
  } catch {
    return { emergency_mode: false, maintenance_mode: false, free_mode: false }
  }
}

function derivePlaybackAllowed(row, policy, access, modes) {
  if (modes.emergency_mode || modes.maintenance_mode) return false
  if (access?.blocked_now === true) return false
  if (policy?.deny_playback === true) return false
  if (access?.active_now === true) return true
  if (modes.free_mode) return true
  return false
}

/**
 * Devices admin-marked unblocked (smart_monitor / allowed, profile blocked=false)
 * where playback is still denied.
 */
export async function auditUnblockedPlaybackMismatches() {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)

  const modes = await loadGlobalModes(pool)
  const { rows } = await pool.query(
    `SELECT
       dsp.device_id,
       dsp.admin_status,
       dsp.security_level,
       dsp.blocked AS profile_blocked,
       dsp.smart_monitor_enabled,
       dsp.unblocked_at,
       dsp.unblocked_by,
       dsp.risk_score,
       dsp.rooted,
       dsp.emulator,
       dsp.clone_detected,
       dsp.debugger,
       dsp.frida,
       dsp.tampered_apk,
       ad.is_blocked AS admin_devices_blocked,
       ds.manual_admin_blocked,
       ds.status AS subscription_status,
       ds.expires_at,
       (ds.status = 'active' AND ds.expires_at > now()) AS active_now,
       (
         COALESCE(ds.manual_admin_blocked, false)
         OR COALESCE(ad.is_blocked, false)
         OR COALESCE(ir.status = 'blocked', false)
       ) AS blocked_now,
       ir.status AS intelligence_status
     FROM device_security_profiles dsp
     LEFT JOIN admin_devices ad ON ad.device_id = dsp.device_id
     LEFT JOIN device_subscriptions ds ON ds.device_id = dsp.device_id
     LEFT JOIN device_intelligence_registry ir ON ir.device_id = dsp.device_id
     WHERE dsp.admin_status IN ('smart_monitor', 'allowed')
       AND COALESCE(dsp.blocked, false) = false
     ORDER BY dsp.last_seen_at DESC NULLS LAST`,
  )

  const affected = []
  const working = []
  const byDenialLayer = {}

  for (const row of rows) {
    const deviceId = String(row.device_id)
    const access = await getDeviceSubscriptionAccessState(deviceId).catch(() => ({
      blocked_now: row.blocked_now === true,
      active_now: row.active_now === true,
    }))
    const policy = await getPlaybackSecurityPolicy(deviceId)
    const denialLayer = classifyDenialLayer(row, policy, access, modes)
    const playbackAllowed = derivePlaybackAllowed(row, policy, access, modes)
    const profileBlocked = row.profile_blocked === true

    const entry = {
      device_id: deviceId,
      admin_status: String(row.admin_status),
      security_level: String(row.security_level || 'warning'),
      smart_monitor_enabled: row.smart_monitor_enabled === true,
      blocked: profileBlocked,
      playback_allowed: playbackAllowed,
      denial_layer: denialLayer,
      layers: {
        manual_admin_blocked: row.manual_admin_blocked === true,
        intelligence_blocked: row.intelligence_status === 'blocked',
        admin_devices_blocked: row.admin_devices_blocked === true,
        profile_blocked: profileBlocked,
        security_deny_playback: policy?.deny_playback === true,
        subscription_blocked_now: access?.blocked_now === true,
        subscription_active: access?.active_now === true,
      },
      unblocked_at: row.unblocked_at,
      unblocked_by: row.unblocked_by ? String(row.unblocked_by) : null,
    }

    if (!playbackAllowed) {
      byDenialLayer[denialLayer] = (byDenialLayer[denialLayer] || 0) + 1
      affected.push(entry)
    } else {
      working.push(entry)
    }
  }

  const fixableLayers = new Set([
    'manual_admin_blocked',
    'intelligence_blocked',
    'admin_devices_blocked',
    'profile_blocked',
    'security_level_blocked',
    'subscription_blocked_now',
  ])
  const fixableAffected = affected.filter((a) => fixableLayers.has(a.denial_layer))

  return {
    generated_at: new Date().toISOString(),
    global_modes: modes,
    total_unblocked_admin_devices: rows.length,
    total_affected: affected.length,
    total_fixable_affected: fixableAffected.length,
    total_subscription_inactive_only: affected.filter((a) => a.denial_layer === 'subscription_inactive')
      .length,
    by_denial_layer: byDenialLayer,
    total_working: working.length,
    affected,
    fixable_affected: fixableAffected,
    working_sample: working.slice(0, 10),
    reference_working_device: working.find((d) => d.device_id === '0523d797b3197a0f') || working[0] || null,
  }
}

function recalcSmartMonitorLevel(row) {
  const flags = {
    rooted: row.rooted === true,
    emulator: row.emulator === true,
    clone_detected: row.clone_detected === true,
    debugger: row.debugger === true,
    frida: row.frida === true,
    tampered_apk: row.tampered_apk === true,
  }
  return resolveSmartMonitorSecurityLevel({
    score: Number(row.risk_score) || 0,
    signals: [],
    flags,
  })
}

/**
 * System-wide repair: sync subscription + intelligence + admin_devices + security_level
 * for every device admin-marked unblocked (smart_monitor / allowed).
 */
export async function reconcileUnblockedPlaybackAccess({ emitUpdates = true } = {}) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)

  const { rows } = await pool.query(
    `SELECT
       dsp.device_id,
       dsp.admin_status,
       dsp.security_level,
       dsp.blocked AS profile_blocked,
       dsp.risk_score,
       dsp.rooted,
       dsp.emulator,
       dsp.clone_detected,
       dsp.debugger,
       dsp.frida,
       dsp.tampered_apk,
       ds.manual_admin_blocked,
       ir.status AS intelligence_status,
       ad.is_blocked AS admin_devices_blocked
     FROM device_security_profiles dsp
     LEFT JOIN device_subscriptions ds ON ds.device_id = dsp.device_id
     LEFT JOIN device_intelligence_registry ir ON ir.device_id = dsp.device_id
     LEFT JOIN admin_devices ad ON ad.device_id = dsp.device_id
     WHERE dsp.admin_status IN ('smart_monitor', 'allowed')
       AND COALESCE(dsp.blocked, false) = false`,
  )

  let manualCleared = 0
  let intelligenceUnblocked = 0
  let adminDevicesCleared = 0
  let securityLevelFixed = 0
  let profileBlockedCleared = 0
  const deviceIds = []

  for (const row of rows) {
    const d = text(row.device_id, 128)
    if (!d) continue
    deviceIds.push(d)

    if (row.manual_admin_blocked === true) {
      await setManualAdminBlocked(d, false)
      manualCleared += 1
    }

    if (row.intelligence_status === 'blocked') {
      const out = await unblockDeviceIntelligenceByDeviceId(d, {
        adminEmail: 'system_reconcile',
        note: 'System-wide unblocked playback reconcile',
      })
      intelligenceUnblocked += out.updated || 0
    }

    if (row.admin_devices_blocked === true) {
      await pool.query(
        `INSERT INTO admin_devices (device_id, is_blocked, block_reason, updated_at)
         VALUES ($1, false, NULL, now())
         ON CONFLICT (device_id) DO UPDATE SET
           is_blocked = false, block_reason = NULL, updated_at = now()`,
        [d],
      )
      adminDevicesCleared += 1
    }

    let targetLevel = String(row.security_level || 'warning')
    if (row.admin_status === 'smart_monitor') {
      targetLevel = recalcSmartMonitorLevel(row)
    } else if (row.admin_status === 'allowed') {
      targetLevel = 'warning'
    }

    if (String(row.security_level) !== targetLevel) {
      await pool.query(
        `UPDATE device_security_profiles SET
           security_level = $2,
           blocked = false,
           updated_at = now()
         WHERE device_id = $1`,
        [d, targetLevel],
      )
      securityLevelFixed += 1
    } else if (row.profile_blocked === true) {
      await pool.query(
        `UPDATE device_security_profiles SET blocked = false, updated_at = now() WHERE device_id = $1`,
        [d],
      )
      profileBlockedCleared += 1
    }

    if (emitUpdates) {
      deviceSubscriptionBus.emit('update', { deviceId: d, source: 'reconcile_unblocked_playback' })
    }
  }

  const postAudit = await auditUnblockedPlaybackMismatches()

  return {
    reconciled_at: new Date().toISOString(),
    devices_scanned: rows.length,
    manual_admin_blocked_cleared: manualCleared,
    intelligence_unblocked: intelligenceUnblocked,
    admin_devices_cleared: adminDevicesCleared,
    security_level_fixed: securityLevelFixed,
    profile_blocked_cleared: profileBlockedCleared,
    device_ids_touched: deviceIds.length,
    post_reconcile: {
      total_affected: postAudit.total_affected,
      affected: postAudit.affected,
    },
  }
}
