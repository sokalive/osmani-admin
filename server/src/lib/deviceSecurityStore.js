import crypto from 'node:crypto'
import { getPool } from '../db/pool.js'

/** User-specified weights; additive scoring. */
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
const ADMIN_STATUSES = ['monitoring', 'allowed', 'whitelisted', 'temp_block', 'perm_block']

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function bool(v) {
  return v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true'
}

export async function ensureDeviceSecurityTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_security_profiles (
      device_id TEXT PRIMARY KEY,
      phone_user TEXT NOT NULL DEFAULT '',
      app_version TEXT NOT NULL DEFAULT '',
      risk_type TEXT NOT NULL DEFAULT '',
      risk_score INT NOT NULL DEFAULT 0,
      rooted BOOLEAN NOT NULL DEFAULT false,
      emulator BOOLEAN NOT NULL DEFAULT false,
      clone_detected BOOLEAN NOT NULL DEFAULT false,
      debugger BOOLEAN NOT NULL DEFAULT false,
      frida BOOLEAN NOT NULL DEFAULT false,
      tampered_apk BOOLEAN NOT NULL DEFAULT false,
      signals JSONB NOT NULL DEFAULT '[]'::jsonb,
      security_level TEXT NOT NULL DEFAULT 'warning',
      admin_status TEXT NOT NULL DEFAULT 'monitoring',
      temp_block_until TIMESTAMPTZ,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      CONSTRAINT device_security_profiles_level_check
        CHECK (security_level IN ('warning', 'limited', 'blocked', 'critical')),
      CONSTRAINT device_security_profiles_admin_status_check
        CHECK (admin_status IN ('monitoring', 'allowed', 'whitelisted', 'temp_block', 'perm_block'))
    );
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS device_security_profiles_level_idx
    ON device_security_profiles (security_level, updated_at DESC);
  `)
  await pool.query(`
    CREATE INDEX IF NOT EXISTS device_security_profiles_last_seen_idx
    ON device_security_profiles (last_seen_at DESC);
  `)
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

/** Score tiers — root-only (+3) stays warning; no instant permaban. */
export function levelFromScore(score, protectionMode = 'manual') {
  const s = Number(score) || 0
  if (s <= 0) return 'warning'
  if (protectionMode === 'manual') return 'warning'
  if (s >= 20) return 'critical'
  if (s >= 15) return 'blocked'
  if (s >= 10) return 'limited'
  return 'warning'
}

async function readProtectionMode(pool) {
  const { rows } = await pool.query(
    `SELECT value FROM app_settings WHERE key = 'security_protection_mode' LIMIT 1`,
  )
  const v = String(rows[0]?.value ?? 'manual')
  return v === 'automatic' ? 'automatic' : 'manual'
}

function rowToDevice(row, adminRow) {
  if (!row) return null
  const whitelisted = adminRow?.whitelisted === true
  const adminBlocked = adminRow?.is_blocked === true
  let status = String(row.admin_status || 'monitoring')
  if (whitelisted) status = 'whitelisted'
  else if (adminBlocked) status = 'perm_block'
  const tempUntil = row.temp_block_until
  if (status === 'temp_block' && tempUntil) {
    const t = tempUntil instanceof Date ? tempUntil : new Date(tempUntil)
    if (!Number.isNaN(t.getTime()) && t.getTime() <= Date.now()) status = 'monitoring'
  }
  return {
    device_id: String(row.device_id),
    phone_user: String(row.phone_user || ''),
    app_version: String(row.app_version || ''),
    risk_type: String(row.risk_type || ''),
    risk_score: Number(row.risk_score) || 0,
    rooted: row.rooted === true,
    emulator: row.emulator === true,
    clone_detected: row.clone_detected === true,
    debugger: row.debugger === true,
    frida: row.frida === true,
    tampered_apk: row.tampered_apk === true,
    last_seen:
      row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : String(row.last_seen_at || ''),
    status,
    security_level: String(row.security_level || 'warning'),
    admin_status: String(row.admin_status || 'monitoring'),
    whitelisted,
    admin_blocked: adminBlocked,
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
  const protectionMode = await readProtectionMode(pool)
  const computedLevel = levelFromScore(score, protectionMode)

  const phone = text(payload.phone ?? payload.phone_user ?? payload.user, 64)
  const appVersion = text(
    payload.app_version ?? payload.appVersion ?? payload.version_name,
    64,
  )
  const details = payload.details && typeof payload.details === 'object' ? payload.details : {}

  const { rows: existing } = await pool.query(
    `SELECT device_id, admin_status, security_level, temp_block_until
     FROM device_security_profiles WHERE device_id = $1`,
    [deviceId],
  )
  const prev = existing[0]
  const adminStatus = String(prev?.admin_status || 'monitoring')
  const overrideStatuses = ['whitelisted', 'temp_block', 'perm_block', 'allowed']
  let securityLevel = computedLevel
  if (overrideStatuses.includes(adminStatus)) {
    if (adminStatus === 'temp_block') securityLevel = 'blocked'
    else if (adminStatus === 'perm_block') securityLevel = 'blocked'
    else if (adminStatus === 'whitelisted') securityLevel = prev?.security_level || 'warning'
    else if (adminStatus === 'allowed') securityLevel = 'warning'
  }

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
         WHEN device_security_profiles.admin_status IN ('whitelisted', 'temp_block', 'perm_block', 'allowed')
         THEN device_security_profiles.security_level
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
      JSON.stringify({ ...details, last_report_at: new Date().toISOString() }),
    ],
  )

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
    risk_score: score,
    security_level: securityLevel,
    is_new: isNew,
    level_changed: levelChanged,
    signals: merged,
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

export async function getSecurityStats() {
  const pool = getPool()
  if (!pool) return { byLevel: {}, total: 0, flagged24h: 0 }
  await ensureDeviceSecurityTables(pool)
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
  let deny = adminBlocked || level === 'blocked' || level === 'critical'
  let limited = level === 'limited'
  if (adminStatus === 'temp_block') {
    const until = r.temp_block_until
    const t = until instanceof Date ? until : until ? new Date(until) : null
    if (t && !Number.isNaN(t.getTime()) && t.getTime() > Date.now()) deny = true
  }
  if (whitelisted) {
    deny = false
    limited = false
  }
  return {
    whitelisted,
    admin_blocked: adminBlocked,
    security_level: level,
    limited_playback: limited && !whitelisted,
    deny_playback: deny && !whitelisted,
  }
}

const ACTION_MAP = {
  allow_device: { admin_status: 'allowed', security_level: 'warning', clear_block: true, whitelist: false },
  whitelist: { admin_status: 'whitelisted', security_level: 'warning', clear_block: true, whitelist: true },
  remove_restriction: {
    admin_status: 'monitoring',
    security_level: null,
    clear_block: true,
    whitelist: false,
    reset_level_from_score: true,
  },
  temporary_block: { admin_status: 'temp_block', security_level: 'blocked', temp_hours: 24 },
  permanent_block: { admin_status: 'perm_block', security_level: 'blocked', perm_block: true },
  reset_risk: {
    admin_status: 'monitoring',
    security_level: 'warning',
    clear_flags: true,
    clear_block: true,
    whitelist: false,
  },
}

export async function applyDeviceSecurityAction(deviceId, action, opts = {}) {
  const pool = getPool()
  if (!pool) throw new Error('Database not configured')
  await ensureDeviceSecurityTables(pool)
  const d = text(deviceId, 128)
  const spec = ACTION_MAP[action]
  if (!d || !spec) throw new Error('Invalid device_id or action')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT * FROM device_security_profiles WHERE device_id = $1`, [d])
    const profile = rows[0]

    if (spec.clear_flags) {
      await client.query(
        `UPDATE device_security_profiles SET
           risk_score = 0, risk_type = '', rooted = false, emulator = false,
           clone_detected = false, debugger = false, frida = false, tampered_apk = false,
           signals = '[]'::jsonb, security_level = 'warning', admin_status = 'monitoring',
           temp_block_until = NULL, updated_at = now()
         WHERE device_id = $1`,
        [d],
      )
    } else if (profile) {
      let level = spec.security_level
      if (spec.reset_level_from_score) {
        const protectionMode = await readProtectionMode(client)
        level = levelFromScore(Number(profile.risk_score) || 0, protectionMode)
      }
      if (level) {
        await client.query(
          `UPDATE device_security_profiles SET
             admin_status = $2, security_level = $3,
             temp_block_until = $4, updated_at = now()
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
          ],
        )
      } else {
        await client.query(
          `UPDATE device_security_profiles SET admin_status = $2, temp_block_until = NULL, updated_at = now()
           WHERE device_id = $1`,
          [d, spec.admin_status],
        )
      }
    } else {
      await client.query(
        `INSERT INTO device_security_profiles (device_id, admin_status, security_level, updated_at)
         VALUES ($1, $2, $3, now())`,
        [d, spec.admin_status, spec.security_level || 'warning'],
      )
    }

    if (spec.clear_block || spec.whitelist === false) {
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
      const reason = text(opts.reason || 'Security: permanent block', 500)
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
