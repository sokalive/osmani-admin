import crypto from 'node:crypto'
import { resolvePaymentPhoneForDevice, setManualAdminBlocked } from '../billingStore.js'
import { getPool } from '../db/pool.js'
import { ensureDeviceSecuritySchema } from '../db/deviceSecuritySchema.js'
import { unblockDeviceIntelligenceByDeviceId } from './deviceIntelligenceStore.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'

/** Display-only weights; strict mode blocks on any signal regardless of score. */
export const RISK_WEIGHTS = {
  root_detected: 3,
  rooted: 3,
  emulator_detected: 5,
  emulator: 5,
  clone_detected: 6,
  clone: 6,
  debug_detected: 4,
  debugger_attached: 4,
  debugger: 4,
  frida_detected: 10,
  frida: 10,
  hook_detected: 7,
  resigned_apk: 10,
  tampered_apk: 10,
  tampered: 10,
  jailbreak_ios: 5,
  dev_client: 1,
}

const LEVELS = ['warning', 'limited', 'blocked', 'critical']
const ADMIN_OVERRIDE_STATUSES = [
  'whitelisted',
  'temp_block',
  'perm_block',
  'allowed',
  'smart_monitor',
]

/** Combined risk score required to re-block a device in Smart Monitor Mode (not single weak signals). */
export const SMART_MONITOR_REBLOCK_SCORE = Math.max(
  10,
  Number(process.env.SMART_MONITOR_REBLOCK_SCORE) || 15,
)

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

export async function ensureDeviceSecurityTables(pool) {
  const db = pool || getPool()
  if (!db) throw new Error('Database not configured')
  return ensureDeviceSecuritySchema(db)
}

export function computeRiskFromSignals(signals) {
  const merged = []
  let score = 0
  const seen = new Set()
  const flags = {
    rooted: false,
    emulator: false,
    clone_detected: false,
    debugger: false,
    frida: false,
    tampered_apk: false,
  }

  const markFlag = (riskType) => {
    const t = String(riskType || '').toLowerCase()
    if (t.includes('root') || t === 'jailbreak_ios') flags.rooted = true
    if (t.includes('emulator')) flags.emulator = true
    if (t.includes('clone')) flags.clone_detected = true
    if (t.includes('debug') || t.includes('debugger')) flags.debugger = true
    if (t.includes('frida') || t.includes('hook')) flags.frida = true
    if (t.includes('resign') || t.includes('tamper')) flags.tampered_apk = true
  }

  for (const raw of signals ?? []) {
    const risk_type = text(raw?.risk_type ?? raw?.riskType, 64)
    if (!risk_type || seen.has(risk_type)) continue
    seen.add(risk_type)
    markFlag(risk_type)
    const weight = RISK_WEIGHTS[risk_type] ?? RISK_WEIGHTS[risk_type.replace(/_detected$/, '')] ?? 1
    const risk_score =
      typeof raw?.risk_score === 'number' && Number.isFinite(raw.risk_score)
        ? Math.max(0, Math.floor(raw.risk_score))
        : weight
    score += risk_score
    merged.push({
      risk_type,
      risk_score,
      ...(raw?.detail != null ? { detail: text(raw.detail, 500) } : {}),
    })
  }

  const primary =
    merged.find((s) => s.risk_score >= 10)?.risk_type ||
    merged.find((s) => s.risk_score >= 5)?.risk_type ||
    merged[0]?.risk_type ||
    ''

  return { score, signals: merged, risk_type: primary, flags }
}

/**
 * Automatic enforcement tier for monitoring devices (strict / automatic mode).
 * ROOT-only, EMULATOR-only, and ROOT+EMULATOR-only → Smart Monitor (warning, not block).
 * FRIDA, APK tampering, debugger, clone, and severe combos → block.
 * @returns {'block'|'smart_monitor'}
 */
export function classifyAutomaticThreatEnforcement(flags) {
  const rooted = flags?.rooted === true
  const emulator = flags?.emulator === true
  const frida = flags?.frida === true
  const tampered = flags?.tampered_apk === true
  const debuggerOn = flags?.debugger === true
  const clone = flags?.clone_detected === true

  if (frida || tampered || debuggerOn || clone) return 'block'
  if (rooted || emulator) return 'smart_monitor'
  return 'block'
}

/** True when any anti-tamper signal is present in this report. */
export function hasDetectionSignals({ score, signals, flags }) {
  if (Number(score) > 0) return true
  if (Array.isArray(signals) && signals.length > 0) return true
  return !!(
    flags?.rooted ||
    flags?.emulator ||
    flags?.clone_detected ||
    flags?.debugger ||
    flags?.frida ||
    flags?.tampered_apk
  )
}

function rowHasStoredThreat(row) {
  if (!row) return false
  if (Number(row.risk_score) > 0) return true
  return !!(
    row.rooted ||
    row.emulator ||
    row.clone_detected ||
    row.debugger ||
    row.frida ||
    row.tampered_apk
  )
}

/**
 * Strict enforcement: any detection → blocked; stays blocked until admin whitelist / unblock / reset.
 * No warning-only or limited tiers for detections.
 */
export function resolveStrictSecurityLevel({ score, signals, flags, prev, adminStatus }) {
  const status = String(adminStatus || 'monitoring')

  if (status === 'whitelisted') {
    return 'warning'
  }
  if (status === 'allowed') {
    return 'warning'
  }
  if (status === 'smart_monitor') {
    return resolveSmartMonitorSecurityLevel({ score, signals, flags })
  }
  if (status === 'temp_block' || status === 'perm_block') {
    return 'blocked'
  }

  const detectedNow = hasDetectionSignals({ score, signals, flags })
  const persistedAutoBlock =
    prev &&
    String(prev.security_level || '') === 'blocked' &&
    status === 'monitoring' &&
    rowHasStoredThreat(prev)

  const effectiveFlags = detectedNow
    ? flags || {}
    : persistedAutoBlock
      ? {
          rooted: prev.rooted === true,
          emulator: prev.emulator === true,
          clone_detected: prev.clone_detected === true,
          debugger: prev.debugger === true,
          frida: prev.frida === true,
          tampered_apk: prev.tampered_apk === true,
        }
      : flags || {}

  if (detectedNow || persistedAutoBlock) {
    const enforcement = classifyAutomaticThreatEnforcement(effectiveFlags)
    if (enforcement === 'smart_monitor') {
      return resolveSmartMonitorSecurityLevel({ score, signals, flags: effectiveFlags })
    }
    return 'blocked'
  }
  return 'warning'
}

/**
 * Smart Monitor Mode — only for manually unblocked devices (admin_status smart_monitor).
 * Collects signals but requires elevated combined score before re-blocking.
 */
export function resolveSmartMonitorSecurityLevel({ score, signals, flags }) {
  const s = Number(score) || 0
  if (s >= SMART_MONITOR_REBLOCK_SCORE) return 'blocked'
  if (flags?.tampered_apk && (flags?.frida || flags?.clone_detected)) return 'blocked'
  if (flags?.frida && flags?.emulator) return 'blocked'
  if (flags?.frida && flags?.debugger && flags?.clone_detected) return 'blocked'
  if (hasDetectionSignals({ score: s, signals, flags })) return 'warning'
  return 'warning'
}

/** @deprecated Use resolveStrictSecurityLevel — kept for admin reset paths. */
export function levelFromScore(score) {
  return Number(score) > 0 ? 'blocked' : 'warning'
}

async function readProtectionMode(pool) {
  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = 'security_protection_mode' LIMIT 1`,
  )
  const v = String(rows[0]?.value ?? 'automatic')
  return v === 'manual' ? 'manual' : 'automatic'
}

/** Strict enforcement is active when protection mode is automatic (default). */
export async function isStrictEnforcementEnabled(pool) {
  const mode = await readProtectionMode(pool)
  return mode === 'automatic'
}

function rowToDevice(row, adminRow) {
  if (!row) return null
  const whitelisted = adminRow?.whitelisted === true
  const adminBlocked = adminRow?.is_blocked === true
  let status = String(row.admin_status || 'monitoring')
  if (whitelisted) status = 'whitelisted'
  else if (adminBlocked) status = 'perm_block'
  else if (row.smart_monitor_enabled === true && status !== 'smart_monitor') status = 'smart_monitor'
  const tempUntil = row.temp_block_until
  if (status === 'temp_block' && tempUntil) {
    const t = tempUntil instanceof Date ? tempUntil : new Date(tempUntil)
    if (!Number.isNaN(t.getTime()) && t.getTime() <= Date.now()) status = 'monitoring'
  }
  const riskReason = String(row.risk_type || '')
  const firstSeen =
    row.first_seen_at instanceof Date ? row.first_seen_at.toISOString() : String(row.first_seen_at || '')
  const lastSeen =
    row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : String(row.last_seen_at || '')
  const detectionTime = Number(row.risk_score) > 0 && firstSeen ? firstSeen : lastSeen

  return {
    device_id: String(row.device_id),
    phone_user: String(row.phone_user || ''),
    phone: String(row.phone_user || ''),
    app_version: String(row.app_version || ''),
    risk_type: riskReason,
    risk_reason: riskReason,
    risk_score: Number(row.risk_score) || 0,
    rooted: row.rooted === true,
    emulator: row.emulator === true,
    clone_detected: row.clone_detected === true,
    debugger: row.debugger === true,
    frida: row.frida === true,
    tampered_apk: row.tampered_apk === true,
    last_seen: lastSeen,
    first_seen: firstSeen,
    detection_time: detectionTime,
    status,
    security_level: String(row.security_level || 'warning'),
    admin_status: String(row.admin_status || 'monitoring'),
    whitelisted,
    admin_blocked: adminBlocked,
    blocked:
      row.blocked === true ||
      adminBlocked ||
      status === 'perm_block' ||
      status === 'temp_block' ||
      (status !== 'allowed' &&
        status !== 'smart_monitor' &&
        status !== 'whitelisted' &&
        String(row.security_level || '') === 'blocked'),
    blocked_at:
      row.blocked_at instanceof Date ? row.blocked_at.toISOString() : row.blocked_at ? String(row.blocked_at) : null,
    blocked_by: String(row.blocked_by ?? ''),
    unblocked_at:
      row.unblocked_at instanceof Date
        ? row.unblocked_at.toISOString()
        : row.unblocked_at
          ? String(row.unblocked_at)
          : null,
    unblocked_by: String(row.unblocked_by ?? ''),
    smart_monitor_enabled: row.smart_monitor_enabled === true || status === 'smart_monitor',
    temp_block_until:
      tempUntil instanceof Date ? tempUntil.toISOString() : tempUntil ? String(tempUntil) : null,
    signals: Array.isArray(row.signals) ? row.signals : [],
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
  }
}

export async function ingestSecurityReport(payload) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)

  const deviceId = text(payload.device_id ?? payload.deviceId, 128)
  if (!deviceId) throw new Error('device_id required')

  const signals = Array.isArray(payload.signals) ? payload.signals : []
  const { score, signals: merged, risk_type, flags } = computeRiskFromSignals(signals)

  let phone = text(payload.phone ?? payload.phone_user ?? payload.user, 64)
  const appVersion = text(
    payload.app_version ?? payload.appVersion ?? payload.version_name,
    64,
  )
  const details = payload.details && typeof payload.details === 'object' ? payload.details : {}

  const { rows: existing } = await pool.query(
    `SELECT device_id, phone_user, admin_status, security_level, temp_block_until,
            risk_score, rooted, emulator, clone_detected, debugger, frida, tampered_apk
     FROM device_security_profiles WHERE device_id = $1`,
    [deviceId],
  )
  const prev = existing[0]

  let phoneResolvedFrom = null
  if (!phone) {
    const resolved = await resolvePaymentPhoneForDevice(deviceId).catch((e) => {
      console.error('[security] resolvePaymentPhoneForDevice failed:', e)
      return { phone: '', source: null }
    })
    if (resolved.phone) {
      phone = text(resolved.phone, 64)
      phoneResolvedFrom = resolved.source
    }
  }
  if (!phone && prev?.phone_user) {
    phone = text(prev.phone_user, 64)
  }
  const adminStatus = String(prev?.admin_status || 'monitoring')

  const strictEnabled = await isStrictEnforcementEnabled(pool)
  const autoEnforcement =
    strictEnabled && adminStatus === 'monitoring' && hasDetectionSignals({ score, signals: merged, flags })
      ? classifyAutomaticThreatEnforcement(flags)
      : null
  let securityLevel = 'warning'
  let promoteSmartMonitor = false
  if (adminStatus === 'smart_monitor') {
    securityLevel = resolveSmartMonitorSecurityLevel({
      score,
      signals: merged,
      flags,
    })
  } else if (ADMIN_OVERRIDE_STATUSES.includes(adminStatus)) {
    if (adminStatus === 'temp_block' || adminStatus === 'perm_block') securityLevel = 'blocked'
    else if (adminStatus === 'whitelisted') securityLevel = String(prev?.security_level || 'warning')
    else if (adminStatus === 'allowed') securityLevel = 'warning'
    else if (adminStatus === 'smart_monitor') {
      securityLevel = resolveSmartMonitorSecurityLevel({ score, signals: merged, flags })
    }
  } else if (strictEnabled) {
    securityLevel = resolveStrictSecurityLevel({
      score,
      signals: merged,
      flags,
      prev,
      adminStatus,
    })
    if (autoEnforcement === 'smart_monitor') {
      promoteSmartMonitor = true
      securityLevel = resolveSmartMonitorSecurityLevel({
        score,
        signals: merged,
        flags,
      })
    }
  }

  const detectedNow = hasDetectionSignals({ score, signals: merged, flags })

  await pool.query(
    `INSERT INTO device_security_profiles (
       device_id, phone_user, app_version, risk_type, risk_score,
       rooted, emulator, clone_detected, debugger, frida, tampered_apk,
       signals, security_level, last_seen_at, updated_at, metadata
     ) VALUES (
       $1, $2, $3, $4, $5,
       $6, $7, $8, $9, $10, $11,
       $12::jsonb, $13, now(), now(), $14::jsonb
     )
     ON CONFLICT (device_id) DO UPDATE SET
       phone_user = COALESCE(NULLIF(EXCLUDED.phone_user, ''), device_security_profiles.phone_user),
       app_version = COALESCE(NULLIF(EXCLUDED.app_version, ''), device_security_profiles.app_version),
       risk_type = EXCLUDED.risk_type,
       risk_score = EXCLUDED.risk_score,
       rooted = EXCLUDED.rooted,
       emulator = EXCLUDED.emulator,
       clone_detected = EXCLUDED.clone_detected,
       debugger = EXCLUDED.debugger,
       frida = EXCLUDED.frida,
       tampered_apk = EXCLUDED.tampered_apk,
       signals = EXCLUDED.signals,
       security_level = CASE
         WHEN device_security_profiles.admin_status IN ('whitelisted', 'temp_block', 'perm_block')
         THEN device_security_profiles.security_level
         WHEN device_security_profiles.admin_status IN ('allowed', 'smart_monitor')
         THEN EXCLUDED.security_level
         ELSE EXCLUDED.security_level
       END,
       last_seen_at = now(),
       updated_at = now(),
       metadata = device_security_profiles.metadata || EXCLUDED.metadata`,
    [
      deviceId,
      phone,
      appVersion,
      risk_type,
      score,
      flags.rooted,
      flags.emulator,
      flags.clone_detected,
      flags.debugger,
      flags.frida,
      flags.tampered_apk,
      JSON.stringify(merged),
      securityLevel,
      JSON.stringify({
        ...details,
        last_report_at: new Date().toISOString(),
        strict_enforcement: strictEnabled,
        ...(phoneResolvedFrom ? { phone_resolved_from: phoneResolvedFrom } : {}),
      }),
    ],
  )

  if (promoteSmartMonitor) {
    const nowIso = new Date().toISOString()
    await pool.query(
      `UPDATE device_security_profiles SET
         admin_status = 'smart_monitor',
         smart_monitor_enabled = true,
         security_level = $2,
         blocked = false,
         blocked_at = NULL,
         blocked_by = '',
         unblocked_at = COALESCE(unblocked_at, $3::timestamptz),
         unblocked_by = CASE WHEN unblocked_at IS NULL THEN $4 ELSE unblocked_by END,
         updated_at = now()
       WHERE device_id = $1`,
      [deviceId, securityLevel, nowIso, 'system:auto_smart_monitor'],
    )
    await pool.query(
      `INSERT INTO admin_devices (device_id, is_blocked, block_reason, whitelisted, updated_at)
       VALUES ($1, false, NULL, false, now())
       ON CONFLICT (device_id) DO UPDATE SET
         is_blocked = false, block_reason = NULL, updated_at = now()`,
      [deviceId],
    )
    await syncPlaybackAccessAfterSecurityAction(deviceId, 'auto_smart_monitor', { clear_block: true }, 'system:auto_smart_monitor')
  }

  await pool.query(
    `INSERT INTO admin_devices (device_id, last_seen_at, updated_at)
     VALUES ($1, now(), now())
     ON CONFLICT (device_id) DO UPDATE SET last_seen_at = now(), updated_at = now()`,
    [deviceId],
  )

  const isNew = !prev
  const levelChanged = prev && String(prev.security_level) !== securityLevel

  return {
    device_id: deviceId,
    phone_user: phone,
    phone_resolved_from: phoneResolvedFrom,
    risk_score: score,
    security_level: securityLevel,
    is_new: isNew,
    level_changed: levelChanged,
    signals: merged,
    detected_now: detectedNow,
    strict_enforcement: strictEnabled,
    security_blocked: strictEnabled && securityLevel === 'blocked',
  }
}

export async function listRiskDevices({ q, level, limit = 500 } = {}) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)
  const lim = Math.min(1000, Math.max(1, Number(limit) || 500))
  const params = []
  const where = []
  if (level && LEVELS.includes(level)) {
    params.push(level)
    where.push(`dsp.security_level = $${params.length}`)
  }
  if (q) {
    params.push(`%${text(q, 80)}%`)
    const i = params.length
    where.push(
      `(dsp.device_id ILIKE $${i} OR dsp.phone_user ILIKE $${i} OR dsp.risk_type ILIKE $${i})`,
    )
  }
  params.push(lim)
  const { rows } = await pool.query(
    `SELECT dsp.*, ad.whitelisted, ad.is_blocked
     FROM device_security_profiles dsp
     LEFT JOIN admin_devices ad ON ad.device_id = dsp.device_id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY dsp.risk_score DESC, dsp.last_seen_at DESC
     LIMIT $${params.length}`,
    params,
  )
  return rows.map((r) => rowToDevice(r, r))
}

export async function getRiskDevice(deviceId) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)
  const d = text(deviceId, 128)
  const { rows } = await pool.query(
    `SELECT dsp.*, ad.whitelisted, ad.is_blocked, ad.block_reason
     FROM device_security_profiles dsp
     LEFT JOIN admin_devices ad ON ad.device_id = dsp.device_id
     WHERE dsp.device_id = $1`,
    [d],
  )
  const device = rowToDevice(rows[0], rows[0])
  if (!device) return null
  return { ...device, block_reason: rows[0]?.block_reason ? String(rows[0].block_reason) : '' }
}

/** One-shot reconcile: block severe threats only; ROOT/EMULATOR-only stay on Smart Monitor path. */
export async function reconcileStrictSecurityLevels(pool) {
  if (!(await isStrictEnforcementEnabled(pool))) return { updated: 0 }
  const out = await pool.query(
    `UPDATE device_security_profiles
     SET security_level = 'blocked', updated_at = now()
     WHERE admin_status = 'monitoring'
       AND security_level IN ('warning', 'limited')
       AND (
         frida = true
         OR tampered_apk = true
         OR debugger = true
         OR clone_detected = true
         OR (
           (risk_score > 0 OR rooted = true OR emulator = true)
           AND NOT (
             (rooted = true OR emulator = true)
             AND frida = false
             AND tampered_apk = false
             AND debugger = false
             AND clone_detected = false
           )
         )
       )`,
  )
  return { updated: Number(out.rowCount) || 0 }
}

function isLowRiskRootEmulatorProfile(row) {
  if (!row) return false
  const rooted = row.rooted === true
  const emulator = row.emulator === true
  if (!rooted && !emulator) return false
  if (row.frida === true || row.tampered_apk === true || row.debugger === true || row.clone_detected === true) {
    return false
  }
  return true
}

/**
 * Migrate a blocked ROOT/EMULATOR-only device to Smart Monitor (all enforcement layers).
 */
export async function migrateLowRiskDeviceToSmartMonitor(deviceId, opts = {}) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)
  const d = text(deviceId, 128)
  const actor = text(opts.actor || 'system:root_emulator_migration', 120)

  const { rows } = await pool.query(`SELECT * FROM device_security_profiles WHERE device_id = $1`, [d])
  const profile = rows[0]
  if (!profile) return { ok: false, reason: 'not_found', device_id: d }
  if (!isLowRiskRootEmulatorProfile(profile)) {
    return { ok: false, reason: 'not_eligible', device_id: d }
  }

  const level = resolveSmartMonitorSecurityLevel({
    score: Number(profile.risk_score) || 0,
    signals: Array.isArray(profile.signals) ? profile.signals : [],
    flags: {
      rooted: profile.rooted === true,
      emulator: profile.emulator === true,
      clone_detected: profile.clone_detected === true,
      debugger: profile.debugger === true,
      frida: profile.frida === true,
      tampered_apk: profile.tampered_apk === true,
    },
  })
  const nowIso = new Date().toISOString()

  await pool.query(
    `UPDATE device_security_profiles SET
       admin_status = 'smart_monitor',
       smart_monitor_enabled = true,
       security_level = $2,
       blocked = false,
       blocked_at = NULL,
       blocked_by = '',
       unblocked_at = COALESCE(unblocked_at, $3::timestamptz),
       unblocked_by = CASE WHEN unblocked_at IS NULL THEN $4 ELSE unblocked_by END,
       updated_at = now()
     WHERE device_id = $1`,
    [d, level, nowIso, actor],
  )
  await pool.query(
    `INSERT INTO admin_devices (device_id, is_blocked, block_reason, whitelisted, updated_at)
     VALUES ($1, false, NULL, false, now())
     ON CONFLICT (device_id) DO UPDATE SET
       is_blocked = false, block_reason = NULL, updated_at = now()`,
    [d],
  )
  await syncPlaybackAccessAfterSecurityAction(d, 'migrate_smart_monitor', { clear_block: true }, actor)

  return { ok: true, device_id: d, security_level: level, smart_monitor: true }
}

/** Audit + optional migrate all blocked ROOT/EMULATOR-only devices. */
export async function auditAndMigrateLowRiskSmartMonitor({ execute = false, actor } = {}) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)

  const { rows } = await pool.query(
    `SELECT dsp.*, ad.is_blocked AS admin_devices_blocked
     FROM device_security_profiles dsp
     LEFT JOIN admin_devices ad ON ad.device_id = dsp.device_id
     WHERE dsp.security_level IN ('blocked', 'critical')
        OR dsp.blocked = true
        OR ad.is_blocked = true`,
  )

  const buckets = {
    root_only: [],
    emulator_only: [],
    root_emulator_only: [],
    keep_blocked: [],
    other: [],
  }

  for (const row of rows) {
    const entry = {
      device_id: String(row.device_id),
      admin_status: String(row.admin_status || ''),
      security_level: String(row.security_level || ''),
      rooted: row.rooted === true,
      emulator: row.emulator === true,
      frida: row.frida === true,
      tampered_apk: row.tampered_apk === true,
      debugger: row.debugger === true,
      clone_detected: row.clone_detected === true,
      risk_type: String(row.risk_type || ''),
      risk_score: Number(row.risk_score) || 0,
    }
    if (!isLowRiskRootEmulatorProfile(row)) {
      if (entry.frida || entry.tampered_apk || entry.debugger || entry.clone_detected) {
        buckets.keep_blocked.push({ ...entry, reason: 'severe_signal' })
      } else if (!entry.rooted && !entry.emulator) {
        buckets.other.push({ ...entry, reason: 'no_root_emulator' })
      } else {
        buckets.keep_blocked.push({ ...entry, reason: 'ineligible_combo' })
      }
      continue
    }
    if (entry.rooted && entry.emulator) buckets.root_emulator_only.push(entry)
    else if (entry.rooted) buckets.root_only.push(entry)
    else buckets.emulator_only.push(entry)
  }

  const eligible = [
    ...buckets.root_only,
    ...buckets.emulator_only,
    ...buckets.root_emulator_only,
  ]

  const migrated = []
  const failed = []
  if (execute) {
    for (const item of eligible) {
      try {
        const out = await migrateLowRiskDeviceToSmartMonitor(item.device_id, { actor })
        if (out.ok) migrated.push(out)
        else failed.push(out)
      } catch (e) {
        failed.push({ ok: false, device_id: item.device_id, error: String(e.message || e) })
      }
    }
    if (migrated.length > 0) {
      const reconcile = await import('./deviceSecurityPlaybackAudit.js')
      await reconcile.reconcileUnblockedPlaybackAccess({ emitUpdates: true })
    }
  }

  return {
    generated_at: new Date().toISOString(),
    execute,
    counts: {
      total_blocked_scanned: rows.length,
      root_only: buckets.root_only.length,
      emulator_only: buckets.emulator_only.length,
      root_emulator_only: buckets.root_emulator_only.length,
      eligible_total: eligible.length,
      keep_blocked: buckets.keep_blocked.length,
      other: buckets.other.length,
      migrated: migrated.length,
      failed: failed.length,
    },
    buckets,
    migrated,
    failed,
  }
}

export async function getSecurityStats() {
  const pool = getPool()
  if (!pool) return { byLevel: {}, total: 0, flagged24h: 0 }
  await ensureDeviceSecurityTables(pool)
  await reconcileStrictSecurityLevels(pool).catch((e) => {
    console.error('[security] reconcileStrictSecurityLevels failed:', e)
  })
  const { rows } = await pool.query(
    `SELECT security_level, COUNT(*)::int AS n
     FROM device_security_profiles
     GROUP BY security_level`,
  )
  const byLevel = {}
  let total = 0
  for (const r of rows) {
    byLevel[String(r.security_level)] = Number(r.n) || 0
    total += Number(r.n) || 0
  }
  const flagged = await pool.query(
    `SELECT COUNT(*)::int AS n FROM device_security_profiles
     WHERE last_seen_at > now() - interval '24 hours' AND risk_score > 0`,
  )
  return { byLevel, total, flagged24h: Number(flagged.rows[0]?.n) || 0 }
}

export async function getPlaybackSecurityPolicy(deviceId) {
  const pool = getPool()
  if (!pool) return null
  await ensureDeviceSecurityTables(pool)
  const d = text(deviceId, 128)
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT dsp.security_level, dsp.admin_status, dsp.temp_block_until,
            dsp.risk_score, dsp.rooted, dsp.emulator, dsp.clone_detected,
            dsp.debugger, dsp.frida, dsp.tampered_apk,
            ad.whitelisted, ad.is_blocked
     FROM device_security_profiles dsp
     LEFT JOIN admin_devices ad ON ad.device_id = dsp.device_id
     WHERE dsp.device_id = $1`,
    [d],
  )
  if (!rows[0]) {
    const adOnly = await pool.query(
      `SELECT whitelisted, is_blocked FROM admin_devices WHERE device_id = $1`,
      [d],
    )
    if (!adOnly.rows[0]) return null
    return {
      whitelisted: adOnly.rows[0].whitelisted === true,
      admin_blocked: adOnly.rows[0].is_blocked === true,
      security_level: 'warning',
      limited_playback: false,
      deny_playback: adOnly.rows[0].is_blocked === true,
    }
  }
  const r = rows[0]
  const whitelisted = r.whitelisted === true
  const adminBlocked = r.is_blocked === true
  const level = String(r.security_level || 'warning')
  const adminStatus = String(r.admin_status || 'monitoring')
  const strictEnabled = await isStrictEnforcementEnabled(pool)
  const hasThreat = rowHasStoredThreat(r)

  let deny =
    adminBlocked ||
    level === 'blocked' ||
    level === 'critical' ||
    (strictEnabled && hasThreat && adminStatus === 'monitoring')

  if (adminStatus === 'smart_monitor') {
    deny = adminBlocked || level === 'blocked' || level === 'critical'
  }

  if (adminStatus === 'temp_block') {
    const until = r.temp_block_until
    const t = until instanceof Date ? until : until ? new Date(until) : null
    if (t && !Number.isNaN(t.getTime()) && t.getTime() > Date.now()) deny = true
  }
  if (whitelisted || adminStatus === 'allowed') {
    deny = false
  }

  return {
    whitelisted,
    admin_blocked: adminBlocked,
    security_level: level,
    limited_playback: false,
    deny_playback: deny,
    smart_monitor_enabled: adminStatus === 'smart_monitor',
  }
}

const ACTION_MAP = {
  allow_device: { admin_status: 'allowed', security_level: 'warning', clear_block: true, whitelist: false },
  whitelist: { admin_status: 'whitelisted', security_level: 'warning', clear_block: true, whitelist: true },
  remove_restriction: {
    admin_status: 'monitoring',
    security_level: 'warning',
    clear_block: true,
    whitelist: false,
    clear_flags: true,
    disable_smart_monitor: true,
  },
  temporary_block: {
    admin_status: 'temp_block',
    security_level: 'blocked',
    temp_hours: 24,
    record_block: true,
    disable_smart_monitor: true,
  },
  permanent_block: {
    admin_status: 'perm_block',
    security_level: 'blocked',
    perm_block: true,
    record_block: true,
    disable_smart_monitor: true,
  },
  block_user: {
    admin_status: 'perm_block',
    security_level: 'blocked',
    perm_block: true,
    record_block: true,
    disable_smart_monitor: true,
  },
  unblock_user: {
    admin_status: 'allowed',
    security_level: 'warning',
    clear_block: true,
    whitelist: false,
    record_unblock: true,
    disable_smart_monitor: true,
  },
  enable_smart_monitor: {
    admin_status: 'smart_monitor',
    security_level: 'warning',
    clear_block: true,
    smart_monitor: true,
    require_prior_unblock: true,
  },
  disable_smart_monitor: {
    admin_status: 'monitoring',
    security_level: 'warning',
    smart_monitor: false,
    reapply_strict_level: true,
  },
  reset_risk: {
    admin_status: 'monitoring',
    security_level: 'warning',
    clear_flags: true,
    clear_block: true,
    whitelist: false,
    disable_smart_monitor: true,
  },
}

function resolveLevelAfterAction(spec, profile) {
  if (spec.reapply_strict_level && profile) {
    const flags = {
      rooted: profile.rooted === true,
      emulator: profile.emulator === true,
      clone_detected: profile.clone_detected === true,
      debugger: profile.debugger === true,
      frida: profile.frida === true,
      tampered_apk: profile.tampered_apk === true,
    }
    const signals = Array.isArray(profile.signals) ? profile.signals : []
    const score = Number(profile.risk_score) || 0
    if (rowHasStoredThreat(profile)) {
      return resolveStrictSecurityLevel({
        score,
        signals,
        flags,
        prev: profile,
        adminStatus: 'monitoring',
      })
    }
  }
  if (spec.admin_status === 'smart_monitor' && profile) {
    const flags = {
      rooted: profile.rooted === true,
      emulator: profile.emulator === true,
      clone_detected: profile.clone_detected === true,
      debugger: profile.debugger === true,
      frida: profile.frida === true,
      tampered_apk: profile.tampered_apk === true,
    }
    return resolveSmartMonitorSecurityLevel({
      score: Number(profile.risk_score) || 0,
      signals: Array.isArray(profile.signals) ? profile.signals : [],
      flags,
    })
  }
  return spec.security_level || 'warning'
}

async function syncPlaybackAccessAfterSecurityAction(deviceId, action, spec, actor) {
  const d = text(deviceId, 128)
  if (!d) return

  if (spec.clear_block || spec.record_unblock) {
    await setManualAdminBlocked(d, false).catch((e) => {
      console.error('[security] setManualAdminBlocked(false) failed:', e)
    })
    await unblockDeviceIntelligenceByDeviceId(d, {
      adminEmail: actor || 'security_center',
      note: `Security unblock: ${action}`,
    }).catch((e) => {
      console.error('[security] unblockDeviceIntelligenceByDeviceId failed:', e)
    })
    deviceSubscriptionBus.emit('update', { deviceId: d, source: 'security_unblock' })
  }

  if (spec.perm_block || spec.record_block) {
    await setManualAdminBlocked(d, true).catch((e) => {
      console.error('[security] setManualAdminBlocked(true) failed:', e)
    })
    deviceSubscriptionBus.emit('update', { deviceId: d, source: 'security_block' })
  }
}

export async function applyDeviceSecurityAction(deviceId, action, opts = {}) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)
  const d = text(deviceId, 128)
  const spec = ACTION_MAP[action]
  if (!d || !spec) throw new Error('Invalid device_id or action')
  const actor = text(opts.actor || 'Admin', 120)
  const now = new Date().toISOString()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT * FROM device_security_profiles WHERE device_id = $1`, [d])
    const profile = rows[0]

    if (spec.require_prior_unblock) {
      const wasUnblocked =
        profile?.unblocked_at != null ||
        profile?.admin_status === 'allowed' ||
        profile?.admin_status === 'whitelisted'
      if (!wasUnblocked && action === 'enable_smart_monitor') {
        throw new Error('Unblock the device before enabling Smart Monitor Mode')
      }
    }

    if (spec.clear_flags) {
      await client.query(
        `UPDATE device_security_profiles SET
           risk_score = 0, risk_type = '', rooted = false, emulator = false,
           clone_detected = false, debugger = false, frida = false, tampered_apk = false,
           signals = '[]'::jsonb, security_level = 'warning', admin_status = 'monitoring',
           temp_block_until = NULL, smart_monitor_enabled = false,
           blocked = false, blocked_at = NULL, blocked_by = '',
           updated_at = now()
         WHERE device_id = $1`,
        [d],
      )
    } else {
      const level = resolveLevelAfterAction(spec, profile)
      const smartMonitorVal = spec.smart_monitor === true
      const disableSmart = spec.disable_smart_monitor === true
      const recordBlock = spec.record_block === true
      const recordUnblock = spec.record_unblock === true

      if (profile) {
        await client.query(
          `UPDATE device_security_profiles SET
             admin_status = $2,
             security_level = $3,
             temp_block_until = $4,
             smart_monitor_enabled = CASE
               WHEN $5::boolean THEN true
               WHEN $6::boolean THEN false
               ELSE smart_monitor_enabled
             END,
             blocked = CASE WHEN $7::boolean THEN true WHEN $8::boolean THEN false ELSE blocked END,
             blocked_at = CASE WHEN $7::boolean THEN $9::timestamptz ELSE blocked_at END,
             blocked_by = CASE WHEN $7::boolean THEN $10 ELSE blocked_by END,
             unblocked_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE unblocked_at END,
             unblocked_by = CASE WHEN $8::boolean THEN $10 ELSE unblocked_by END,
             updated_at = now()
           WHERE device_id = $1`,
          [
            d,
            spec.admin_status,
            level,
            spec.temp_hours
              ? new Date(Date.now() + spec.temp_hours * 3600 * 1000).toISOString()
              : spec.admin_status === 'temp_block'
                ? new Date(Date.now() + 24 * 3600 * 1000).toISOString()
                : null,
            smartMonitorVal,
            disableSmart || spec.smart_monitor === false,
            recordBlock,
            recordUnblock,
            now,
            actor,
          ],
        )
      } else {
        await client.query(
          `INSERT INTO device_security_profiles (
             device_id, admin_status, security_level, smart_monitor_enabled,
             blocked, blocked_at, blocked_by, unblocked_at, unblocked_by, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())`,
          [
            d,
            spec.admin_status,
            level,
            smartMonitorVal,
            recordBlock,
            recordBlock ? now : null,
            recordBlock ? actor : '',
            recordUnblock ? now : null,
            recordUnblock ? actor : '',
          ],
        )
      }
    }

    if (spec.clear_block || spec.whitelist === false || spec.record_unblock) {
      await client.query(
        `INSERT INTO admin_devices (device_id, is_blocked, whitelisted, block_reason, updated_at)
         VALUES ($1, false, false, NULL, now())
         ON CONFLICT (device_id) DO UPDATE SET
           is_blocked = false, whitelisted = false, block_reason = NULL, updated_at = now()`,
        [d],
      )
    }
    if (spec.whitelist) {
      await client.query(
        `INSERT INTO admin_devices (device_id, whitelisted, is_blocked, updated_at)
         VALUES ($1, true, false, now())
         ON CONFLICT (device_id) DO UPDATE SET whitelisted = true, is_blocked = false, updated_at = now()`,
        [d],
      )
    }
    if (spec.perm_block) {
      const reason = text(opts.reason || 'Security: admin block', 500)
      await client.query(
        `INSERT INTO admin_devices (device_id, is_blocked, block_reason, whitelisted, updated_at)
         VALUES ($1, true, $2, false, now())
         ON CONFLICT (device_id) DO UPDATE SET
           is_blocked = true, block_reason = EXCLUDED.block_reason, whitelisted = false, updated_at = now()`,
        [d, reason],
      )
    }

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK')
    throw e
  } finally {
    client.release()
  }

  await syncPlaybackAccessAfterSecurityAction(d, action, spec, actor)

  return getRiskDevice(d)
}

export async function applyBulkDeviceSecurityAction(deviceIds, action) {
  const ids = [...new Set((deviceIds ?? []).map((x) => text(x, 128)).filter(Boolean))]
  const results = []
  for (const id of ids) {
    results.push(await applyDeviceSecurityAction(id, action))
  }
  return { updated: results.length, devices: results }
}

export function newDetectionEventId() {
  return crypto.randomUUID()
}
