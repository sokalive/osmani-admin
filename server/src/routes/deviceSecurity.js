import crypto from 'node:crypto'
import { Router } from 'express'
import * as billing from '../billingStore.js'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import { ensureSubscriptionLinkedForDevice } from '../lib/subscriptionRecovery.js'
import { notifySubscriptionTransferred, toAccessCacheRow } from '../lib/subscriptionTransferNotify.js'
import {
  publishPhoneGateChanged,
  readPhoneGateEnabled,
  writePhoneGateEnabled,
} from '../lib/phoneGateSettings.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import {
  verifyAdminSensitiveActionPassword,
  sensitiveActionPasswordFromBody,
} from '../lib/adminSensitiveActionPassword.js'
import {
  commitSubscriptionTransfer,
  publishTransferConfirmationRequired,
  publishTransferRealtime,
} from '../lib/transferSubscriptionMove.js'

export const deviceSecurityRouter = Router()

deviceSecurityRouter.use('/settings/device-control', requireAdminPanelAccess)
deviceSecurityRouter.use('/settings/security-suite', requireAdminPanelAccess)
deviceSecurityRouter.use('/security-logs', requireAdminPanelAccess)
deviceSecurityRouter.use('/transfer-codes', requireAdminPanelAccess)

const TRANSFER_CODE_TTL_MINUTES = Math.max(5, Number(process.env.TRANSFER_CODE_TTL_MINUTES) || 30)
const FINGERPRINT_SALT = String(process.env.FINGERPRINT_HASH_SALT || 'osmani-fp-v1')

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function toInt(v, fallback, min = 0, max = 100000) {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.floor(n)))
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex')
}

function fingerprintHash(raw) {
  const value = text(raw, 1024)
  if (!value) return null
  return sha256(`${FINGERPRINT_SALT}::${value}`)
}

function randomTransferCode() {
  const n = crypto.randomInt(0, 1000000)
  return `TR-${n.toString().padStart(6, '0')}`
}

async function ensureSecurityTables(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS transfer_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code TEXT NOT NULL UNIQUE,
      source_device_id TEXT NOT NULL,
      target_device_id TEXT,
      target_fingerprint_hash TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      revoked_at TIMESTAMPTZ,
      created_by TEXT NOT NULL DEFAULT 'system',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS device_transfers (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code_id UUID REFERENCES transfer_codes (id) ON DELETE SET NULL,
      code TEXT,
      source_device_id TEXT NOT NULL,
      target_device_id TEXT NOT NULL,
      source_fingerprint_hash TEXT,
      target_fingerprint_hash TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      reason TEXT,
      requested_by TEXT NOT NULL DEFAULT 'device',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      completed_at TIMESTAMPTZ
    );
  `)
  await pool.query(`ALTER TABLE device_transfers ADD COLUMN IF NOT EXISTS idempotency_key TEXT`)
  await pool.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS device_transfers_idempotency_key_unique
    ON device_transfers (idempotency_key)
    WHERE idempotency_key IS NOT NULL AND trim(idempotency_key) <> ''
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS security_events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      actor TEXT NOT NULL DEFAULT '',
      event_type TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'completed',
      detail TEXT NOT NULL DEFAULT '',
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id TEXT NOT NULL UNIQUE,
      fingerprint_hash TEXT,
      is_blocked BOOLEAN NOT NULL DEFAULT false,
      block_reason TEXT,
      whitelisted BOOLEAN NOT NULL DEFAULT false,
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_otp_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      admin_id TEXT NOT NULL DEFAULT 'admin',
      code_hash TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'force_transfer',
      status TEXT NOT NULL DEFAULT 'active',
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
}

/** Ensures KV table exists and transfer policy rows exist (idempotent ON CONFLICT DO NOTHING). */
async function ensureTransferSettingsInfrastructure(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES
      ('transfer_mode', 'confirmation'),
      ('transfer_daily_limit', '5'),
      ('transfer_weekly_limit', '15'),
      ('transfer_cooldown_minutes', '60'),
      ('phone_gate_enabled', 'true')
    ON CONFLICT (key) DO NOTHING;
  `)
}

async function upsertAppSetting(pool, key, value) {
  const str = String(value ?? '')
  const res = await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
     RETURNING key, value`,
    [key, str],
  )
  return { rowCount: Number(res.rowCount) || 0, row: res.rows[0] || null }
}

async function saveAppSettings(pool, entries) {
  const out = {}
  for (const [k, v] of Object.entries(entries)) {
    out[k] = await upsertAppSetting(pool, k, v)
  }
  return out
}

async function readAppSettings(pool, defaults) {
  const keys = Object.keys(defaults)
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [keys])
  const out = { ...defaults }
  for (const row of rows) out[String(row.key)] = String(row.value ?? '')
  return out
}

const TRANSFER_SETTING_KEYS = {
  mode: 'transfer_mode',
  daily: 'transfer_daily_limit',
  weekly: 'transfer_weekly_limit',
  cooldown: 'transfer_cooldown_minutes',
}

const SECURITY_SETTING_KEYS = {
  protectionMode: 'security_protection_mode',
}

/** Exact client copy for POST /transfer/request when daily / weekly caps are exceeded. */
const TRANSFER_LIMIT_FORBIDDEN_MESSAGE =
  'Umefikia kiwango cha mwisho cha kuamisha kifurushi. Tafadhali wasiliana na muhudumu kama unahitaji kuamisha kifurushi tena.'

async function readTransferSettingsLive(pool) {
  await ensureTransferSettingsInfrastructure(pool)
  const keys = Object.values(TRANSFER_SETTING_KEYS)
  /** Prefer latest updated row per key if duplicates ever exist (defensive). */
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (key) key, value, updated_at
     FROM app_settings
     WHERE key = ANY($1::text[])
     ORDER BY key, updated_at DESC NULLS LAST`,
    [keys],
  )
  const dupProbe = await pool.query(
    `SELECT key, COUNT(*)::int AS n
     FROM app_settings
     WHERE key = ANY($1::text[])
     GROUP BY key
     HAVING COUNT(*) > 1`,
    [keys],
  )
  if ((dupProbe.rowCount ?? 0) > 0) {
    console.warn('[device-control] duplicate app_settings keys detected', dupProbe.rows)
  }
  const byKey = {}
  for (const r of rows) byKey[String(r.key)] = String(r.value ?? '')
  const missingKeys = keys.filter((k) => !(k in byKey))
  if (missingKeys.length > 0) {
    throw new Error(`Missing transfer settings rows in app_settings: ${missingKeys.join(', ')}`)
  }
  return {
    transferMode: byKey[TRANSFER_SETTING_KEYS.mode] === 'manual' ? 'manual' : 'confirmation',
    dailyLimit: toInt(byKey[TRANSFER_SETTING_KEYS.daily], 5, 1, 1000),
    weeklyLimit: toInt(byKey[TRANSFER_SETTING_KEYS.weekly], 15, 1, 5000),
    cooldownMinutes: toInt(byKey[TRANSFER_SETTING_KEYS.cooldown], 60, 1, 1440),
    phoneGateEnabled: await readPhoneGateEnabled(pool),
    dbRows: rows.map((r) => ({
      key: String(r.key),
      value: String(r.value ?? ''),
      updated_at: r.updated_at instanceof Date ? r.updated_at.toISOString() : String(r.updated_at),
    })),
  }
}

async function ensureSecuritySettingsInfrastructure(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT '',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `)
  await pool.query(`
    INSERT INTO app_settings (key, value)
    VALUES ('security_protection_mode', 'automatic')
    ON CONFLICT (key) DO NOTHING;
  `)
}

async function readSecuritySuiteSettings(pool) {
  await ensureSecuritySettingsInfrastructure(pool)
  const settings = await readAppSettings(pool, {
    [SECURITY_SETTING_KEYS.protectionMode]: 'automatic',
  })
  return {
    protectionMode:
      String(settings[SECURITY_SETTING_KEYS.protectionMode] || 'automatic') === 'manual'
        ? 'manual'
        : 'automatic',
  }
}

function adminActor(req, fallback = 'Admin') {
  return text(req.adminAuth?.email ?? fallback, 120)
}

async function logSecurityEvent(pool, { actor, eventType, status, detail, metadata = {} }) {
  await pool.query(
    `INSERT INTO security_events (actor, event_type, status, detail, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
    [text(actor, 120), text(eventType, 120), text(status, 32), text(detail, 2000), metadata || {}],
  )
}

function emitSync(event, payload) {
  liveSyncBus.publish(event, {
    topics: ['config'],
    ...payload,
    synced_at: new Date().toISOString(),
  })
  void recordSystemNotificationEvent(event, payload).catch((err) => {
    console.error('[device-security] notification sync failed:', err)
  })
}

async function cleanupSecurity(pool) {
  await pool.query(
    `UPDATE transfer_codes
     SET status = 'expired', updated_at = now()
     WHERE status = 'active' AND expires_at <= now()`,
  )
  await pool.query(
    `UPDATE admin_otp_codes
     SET status = 'expired'
     WHERE status = 'active' AND expires_at <= now()`,
  )
  await pool.query(
    `UPDATE device_transfers dt
     SET status = CASE
       WHEN tc.status = 'revoked' THEN 'revoked'
       ELSE 'expired'
     END,
         reason = CASE
       WHEN tc.status = 'revoked' THEN 'revoked_by_admin'
       ELSE 'code_expired'
     END
     FROM transfer_codes tc
     WHERE dt.code_id = tc.id
       AND dt.status IN ('requested', 'awaiting_target_submission', 'pending_confirmation')
       AND tc.status IN ('expired', 'revoked')`,
  )
}

async function resolveSubscriptionByDevice(pool, deviceId) {
  const { rows } = await pool.query(
    `SELECT device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash
     FROM device_subscriptions
     WHERE device_id = $1
     FOR UPDATE`,
    [deviceId],
  )
  return rows[0] ?? null
}

async function checkTransferLimits(pool, sourceDeviceId, cooldownMinutes, dailyLimit, weeklyLimit) {
  const { rows } = await pool.query(
    `SELECT
       COUNT(*) FILTER (
         WHERE status = 'completed'
           AND COALESCE(completed_at, created_at) >= now() - interval '1 day'
       )::int AS day_count,
       COUNT(*) FILTER (
         WHERE status = 'completed'
           AND COALESCE(completed_at, created_at) >= now() - interval '7 day'
       )::int AS week_count,
       MAX(COALESCE(completed_at, created_at)) FILTER (WHERE status = 'completed') AS last_completed_at
     FROM device_transfers
     WHERE source_device_id = $1`,
    [sourceDeviceId],
  )
  const r = rows[0] || {}
  const dayCount = Number(r.day_count) || 0
  const weekCount = Number(r.week_count) || 0
  const lastCompletedAtMs = r.last_completed_at ? new Date(r.last_completed_at).getTime() : null
  const cooldownMs = cooldownMinutes * 60 * 1000
  const nowMs = Date.now()
  if (dayCount >= dailyLimit) return { ok: false, reason: 'Daily transfer limit reached', dayCount, weekCount }
  if (weekCount >= weeklyLimit) return { ok: false, reason: 'Weekly transfer limit reached', dayCount, weekCount }
  if (lastCompletedAtMs && nowMs - lastCompletedAtMs < cooldownMs) {
    const retryAfterSec = Math.max(1, Math.ceil((lastCompletedAtMs + cooldownMs - nowMs) / 1000))
    return {
      ok: false,
      reason: 'Transfer cooldown active',
      dayCount,
      weekCount,
      retryAfterSec,
      cooldownUntilMs: lastCompletedAtMs + cooldownMs,
    }
  }
  return { ok: true, dayCount, weekCount, cooldownMinutes }
}

/** Shared admin force transfer by device IDs. Emits SSE + subscription bus after commit. */
export async function executeAdminForceTransfer(pool, {
  sourceDeviceId,
  targetDeviceId,
  targetFpHash,
  actor,
  auditExtra,
  idempotencyKey = null,
}) {
  const src = text(sourceDeviceId, 128)
  const tgt = text(targetDeviceId, 128)
  if (!src || !tgt) return { ok: false, status: 400, error: 'source_device_id and target_device_id are required' }
  if (src === tgt) return { ok: false, status: 400, error: 'Source and target device must differ' }

  const idem = text(idempotencyKey, 128)
  if (idem) {
    const prior = await pool.query(
      `SELECT source_device_id, target_device_id, status
       FROM device_transfers
       WHERE idempotency_key = $1 AND status = 'completed'
       LIMIT 1`,
      [idem],
    )
    if (prior.rows[0]) {
      return {
        ok: true,
        idempotent: true,
        source_device_id: String(prior.rows[0].source_device_id),
        target_device_id: String(prior.rows[0].target_device_id),
      }
    }
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const code = randomTransferCode()
    const move = await commitSubscriptionTransfer(client, {
      sourceDeviceId: src,
      targetDeviceId: tgt,
      targetFpHash,
      code,
      transactionPrefix: 'force',
      transferReason: 'admin_force',
      notifyReason: 'admin_force_transfer',
      userInitiatedTransfer: true,
    })
    if (!move.ok) {
      await client.query('ROLLBACK')
      return move
    }
    await client.query(
      `INSERT INTO transfer_codes
       (code, source_device_id, target_device_id, target_fingerprint_hash, status, expires_at, created_by, created_at, updated_at, used_at)
       VALUES ($1, $2, $3, $4, 'used', now() + interval '10 minutes', 'admin_force', now(), now(), now())`,
      [code, src, tgt, targetFpHash],
    )
    await client.query(
      `INSERT INTO device_transfers
       (code, source_device_id, target_device_id, source_fingerprint_hash, target_fingerprint_hash, status, reason, requested_by, created_at, completed_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, 'completed', 'admin_force', 'admin', now(), now(), $6)`,
      [code, src, tgt, move.sourceAfter?.fingerprint_hash || null, targetFpHash, idem || null],
    )
    const extra = auditExtra ? String(auditExtra).slice(0, 500) : ''
    await logSecurityEvent(client, {
      actor: text(actor || 'Admin', 120),
      eventType: 'Force transfer',
      status: 'completed',
      detail: `Force transferred ${src} -> ${tgt}${extra ? ` · ${extra}` : ''}`,
      metadata: { source_device_id: src, target_device_id: tgt, idempotency_key: idem || null },
    })
    await client.query('COMMIT')
    publishTransferRealtime({
      sourceDeviceId: src,
      targetDeviceId: tgt,
      sourceAfter: move.sourceAfter,
      targetAfter: move.targetAfter,
      reason: 'admin_force_transfer',
      userInitiatedTransfer: true,
      syncReason: 'admin_force',
    })
    emitSync('transfer_codes_changed', { action: 'admin_force', source_device_id: src, target_device_id: tgt })
    emitSync('security_logs_changed', { action: 'admin_force', source_device_id: src, target_device_id: tgt })
    return { ok: true, source_device_id: src, target_device_id: tgt, expires_at: move.expiresAt }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

deviceSecurityRouter.get('/settings/device-control', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const live = await readTransferSettingsLive(pool)
    const pendingRows = await pool.query(
      `SELECT id, source_device_id, target_device_id, created_at, status
       FROM device_transfers
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    const logsRows = await pool.query(
      `SELECT id, created_at, detail
       FROM security_events
       WHERE event_type ILIKE '%transfer%'
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    const responseBody = {
      transferMode: live.transferMode,
      dailyLimit: live.dailyLimit,
      weeklyLimit: live.weeklyLimit,
      cooldownMinutes: live.cooldownMinutes,
      phoneGateEnabled: live.phoneGateEnabled,
      phone_gate_enabled: live.phoneGateEnabled,
      pending: pendingRows.rows
        .filter((r) =>
          ['requested', 'awaiting_target_submission', 'pending_confirmation', 'completed', 'rejected', 'revoked', 'expired'].includes(
            String(r.status),
          ),
        )
        .map((r) => ({
          id: String(r.id),
          sourceDeviceId: String(r.source_device_id ?? ''),
          deviceLabel: `${r.source_device_id} -> ${r.target_device_id || 'pending'}`,
          requestedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          status: String(r.status),
        })),
      logs: logsRows.rows.map((r) => ({
        id: String(r.id),
        at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        message: String(r.detail || ''),
      })),
    }
    console.log('[device-control] GET settings persisted rows', live.dbRows)
    console.log('[device-control] GET settings response', responseBody)
    return res.json(responseBody)
  } catch (e) {
    console.error('[device-control] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.put('/settings/device-control', async (req, res) => {
  const client = (await getPool()?.connect?.()) || null
  try {
    const pool = getPool()
    if (!pool || !client) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(client)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    console.log('[device-control] PUT raw req.body keys', Object.keys(b))
    await client.query('BEGIN')
    const before = await readTransferSettingsLive(client)
    const phoneGateRaw = b.phoneGateEnabled ?? b.phone_gate_enabled
    const phoneGateTouched = phoneGateRaw !== undefined
    const payload = {
      transferMode: String(b.transferMode || 'confirmation') === 'manual' ? 'manual' : 'confirmation',
      dailyLimit: toInt(b.dailyLimit, before.dailyLimit, 1, 1000),
      weeklyLimit: toInt(b.weeklyLimit, before.weeklyLimit, 1, 5000),
      cooldownMinutes: toInt(b.cooldownMinutes, before.cooldownMinutes, 1, 1440),
      phoneGateEnabled: phoneGateTouched
        ? !(String(phoneGateRaw).toLowerCase() === 'false' || phoneGateRaw === false || phoneGateRaw === 0)
        : before.phoneGateEnabled,
    }
    console.log('[device-control] PUT incoming payload', {
      beforeSnapshot: {
        dailyLimit: before.dailyLimit,
        weeklyLimit: before.weeklyLimit,
        cooldownMinutes: before.cooldownMinutes,
        phoneGateEnabled: before.phoneGateEnabled,
      },
    })
    const upsertResults = await saveAppSettings(client, {
      [TRANSFER_SETTING_KEYS.mode]: payload.transferMode,
      [TRANSFER_SETTING_KEYS.daily]: payload.dailyLimit,
      [TRANSFER_SETTING_KEYS.weekly]: payload.weeklyLimit,
      [TRANSFER_SETTING_KEYS.cooldown]: payload.cooldownMinutes,
    })
    if (phoneGateTouched) {
      await writePhoneGateEnabled(client, payload.phoneGateEnabled)
    }
    await logSecurityEvent(client, {
      actor: adminActor(req),
      eventType: 'Device control updated',
      status: 'completed',
      detail: `transfer_mode:${payload.transferMode} daily:${payload.dailyLimit} weekly:${payload.weeklyLimit} cooldown:${payload.cooldownMinutes} phone_gate:${payload.phoneGateEnabled}`,
      metadata: {
        transfer_mode: payload.transferMode,
        daily_limit: payload.dailyLimit,
        weekly_limit: payload.weeklyLimit,
        cooldown_minutes: payload.cooldownMinutes,
        phone_gate_enabled: payload.phoneGateEnabled,
      },
    })
    console.log('[device-control] PUT upsert rowCount/returned', upsertResults)
    const live = await readTransferSettingsLive(client)
    const pendingRows = await client.query(
      `SELECT id, source_device_id, target_device_id, created_at, status
       FROM device_transfers
       ORDER BY created_at DESC
       LIMIT 100`,
    )
    const logsRows = await client.query(
      `SELECT id, created_at, detail
       FROM security_events
       WHERE event_type ILIKE '%transfer%'
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    await client.query('COMMIT')
    emitSync('app_settings_changed', payload)
    if (phoneGateTouched) {
      publishPhoneGateChanged(payload.phoneGateEnabled)
      emitSync('phone_gate_changed', { phone_gate_enabled: payload.phoneGateEnabled })
    }
    const responseBody = {
      transferMode: live.transferMode,
      dailyLimit: live.dailyLimit,
      weeklyLimit: live.weeklyLimit,
      cooldownMinutes: live.cooldownMinutes,
      phoneGateEnabled: live.phoneGateEnabled,
      phone_gate_enabled: live.phoneGateEnabled,
      pending: pendingRows.rows
        .filter((r) =>
          ['requested', 'awaiting_target_submission', 'pending_confirmation', 'completed', 'rejected', 'revoked', 'expired'].includes(
            String(r.status),
          ),
        )
        .map((r) => ({
          id: String(r.id),
          sourceDeviceId: String(r.source_device_id ?? ''),
          deviceLabel: `${r.source_device_id} -> ${r.target_device_id || 'pending'}`,
          requestedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
          status: String(r.status),
        })),
      logs: logsRows.rows.map((r) => ({
        id: String(r.id),
        at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        message: String(r.detail || ''),
      })),
    }
    console.log('[device-control] PUT save payload', payload)
    console.log('[device-control] PUT old->new', {
      old: {
        transferMode: before.transferMode,
        dailyLimit: before.dailyLimit,
        weeklyLimit: before.weeklyLimit,
        cooldownMinutes: before.cooldownMinutes,
      },
      next: {
        transferMode: live.transferMode,
        dailyLimit: live.dailyLimit,
        weeklyLimit: live.weeklyLimit,
        cooldownMinutes: live.cooldownMinutes,
        phoneGateEnabled: live.phoneGateEnabled,
      },
    })
    console.log('[device-control] PUT persisted rows', live.dbRows)
    console.log('[device-control] PUT commit success', { ok: true })
    console.log('[device-control] PUT settings response', responseBody)
    emitSync('device_control_changed', payload)
    emitSync('security_logs_changed', { section: 'device_control' })
    return res.json(responseBody)
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('[device-control] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (client) client.release()
  }
})

deviceSecurityRouter.get('/settings/security-suite', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const suiteSettings = await readSecuritySuiteSettings(pool)
    const blockedRows = await pool.query(
      `SELECT device_id, block_reason, updated_at
       FROM admin_devices
       WHERE is_blocked = true
       ORDER BY updated_at DESC`,
    )
    const whitelistRows = await pool.query(
      `SELECT device_id
       FROM admin_devices
       WHERE whitelisted = true
       ORDER BY updated_at DESC`,
    )
    const alertRows = await pool.query(
      `SELECT id, actor, event_type, detail, status, created_at, metadata
       FROM security_events
       WHERE status IN ('failed', 'blocked', 'warning', 'pending')
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    return res.json({
      protectionMode: suiteSettings.protectionMode,
      whitelist: whitelistRows.rows.map((r) => ({ id: String(r.device_id), value: String(r.device_id) })),
      blockedUsers: blockedRows.rows.map((r) => ({
        id: String(r.device_id),
        value: String(r.device_id),
        reason: String(r.block_reason || ''),
      })),
      alerts: alertRows.rows.map((r) => ({
        id: String(r.id),
        actor: String(r.actor || ''),
        title: String(r.event_type || r.actor || 'Security alert'),
        deviceOrIp: String(r.detail || ''),
        time: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        timestamp: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        status: String(r.status) === 'completed' ? 'resolved' : 'active',
        kind: String(r.metadata?.kind || 'pattern'),
      })),
    })
  } catch (e) {
    console.error('[security-suite] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.put('/settings/security-suite', async (req, res) => {
  const pool = getPool()
  const client = (await pool?.connect?.()) || null
  try {
    if (!pool || !client) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(client)
    await ensureSecuritySettingsInfrastructure(client)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const whitelist = Array.isArray(b.whitelist) ? b.whitelist : []
    const blockedUsers = Array.isArray(b.blockedUsers) ? b.blockedUsers : []
    const protectionMode = String(b.protectionMode || 'automatic') === 'manual' ? 'manual' : 'automatic'
    await client.query('BEGIN')
    try {
      await client.query(`UPDATE admin_devices SET whitelisted = false, updated_at = now() WHERE whitelisted = true`)
      for (const w of whitelist) {
        const deviceId = text(w?.value ?? w?.id, 128)
        if (!deviceId) continue
        await client.query(
          `INSERT INTO admin_devices (device_id, whitelisted, updated_at)
           VALUES ($1, true, now())
           ON CONFLICT (device_id) DO UPDATE SET whitelisted = true, updated_at = now()`,
          [deviceId],
        )
      }
      await client.query(`UPDATE admin_devices SET is_blocked = false, block_reason = NULL, updated_at = now()`)
      for (const bl of blockedUsers) {
        const deviceId = text(bl?.value ?? bl?.id, 128)
        if (!deviceId) continue
        await client.query(
          `INSERT INTO admin_devices (device_id, is_blocked, block_reason, updated_at)
           VALUES ($1, true, $2, now())
           ON CONFLICT (device_id) DO UPDATE SET
             is_blocked = true,
             block_reason = EXCLUDED.block_reason,
             updated_at = now()`,
          [deviceId, text(bl?.reason, 500)],
        )
      }
      await upsertAppSetting(client, SECURITY_SETTING_KEYS.protectionMode, protectionMode)
      await logSecurityEvent(client, {
        actor: adminActor(req),
        eventType: 'Security suite updated',
        status: 'completed',
        detail: `protection_mode:${protectionMode} whitelist:${whitelist.length} blocked:${blockedUsers.length}`,
        metadata: {
          protection_mode: protectionMode,
          whitelist_count: whitelist.length,
          blocked_count: blockedUsers.length,
        },
      })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
    emitSync('app_settings_changed', { section: 'security_suite' })
    emitSync('security_suite_changed', { protectionMode })
    emitSync('security_logs_changed', { section: 'security_suite' })
    emitSync('security_alerts_changed', { section: 'security_suite' })
    const alertRows = await client.query(
      `SELECT id, actor, event_type, detail, status, created_at, metadata
       FROM security_events
       WHERE status IN ('failed', 'blocked', 'warning', 'pending')
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    return res.json({
      protectionMode,
      whitelist,
      blockedUsers,
      alerts: alertRows.rows.map((r) => ({
        id: String(r.id),
        actor: String(r.actor || ''),
        title: String(r.event_type || r.actor || 'Security alert'),
        deviceOrIp: String(r.detail || ''),
        time: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        timestamp: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        status: String(r.status) === 'completed' ? 'resolved' : 'active',
        kind: String(r.metadata?.kind || 'pattern'),
      })),
    })
  } catch (e) {
    console.error('[security-suite] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (client) client.release()
  }
})

deviceSecurityRouter.post('/settings/security-suite/restore-whitelist', async (req, res) => {
  const pool = getPool()
  const client = (await pool?.connect?.()) || null
  try {
    if (!pool || !client) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(client)
    await ensureSecuritySettingsInfrastructure(client)
    const defaults = ['127.0.0.1', 'localhost']
    await client.query('BEGIN')
    try {
      await client.query(`UPDATE admin_devices SET whitelisted = false, updated_at = now() WHERE whitelisted = true`)
      for (const d of defaults) {
        await client.query(
          `INSERT INTO admin_devices (device_id, whitelisted, updated_at)
           VALUES ($1, true, now())
           ON CONFLICT (device_id) DO UPDATE SET whitelisted = true, updated_at = now()`,
          [d],
        )
      }
      await logSecurityEvent(client, {
        actor: adminActor(req),
        eventType: 'Security whitelist restored',
        status: 'completed',
        detail: 'Whitelist reset to default localhost entries',
        metadata: { defaults },
      })
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK')
      throw e
    }
    emitSync('app_settings_changed', { section: 'security_suite_whitelist' })
    emitSync('security_suite_changed', { section: 'whitelist_defaults' })
    emitSync('security_logs_changed', { section: 'security_suite_whitelist' })
    emitSync('security_alerts_changed', { section: 'security_suite_whitelist' })
    const suiteSettings = await readSecuritySuiteSettings(client)
    return res.json({
      protectionMode: suiteSettings.protectionMode,
      whitelist: defaults.map((v) => ({ id: v, value: v })),
      blockedUsers: [],
      alerts: [],
    })
  } catch (e) {
    console.error('[security-suite] restore whitelist', e)
    return res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (client) client.release()
  }
})

deviceSecurityRouter.delete('/settings/security-suite/alerts/:id', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const id = text(req.params.id, 64)
    console.log('[security-suite] alert delete request', { id })
    const { rowCount } = await pool.query(`DELETE FROM security_events WHERE id = $1::uuid`, [id])
    console.log('[security-suite] alert delete result', { id, deleted: Number(rowCount) || 0 })
    if (!rowCount) return res.status(404).json({ error: 'Alert not found' })
    await logSecurityEvent(pool, {
      actor: adminActor(req),
      eventType: 'Security alert deleted',
      status: 'completed',
      detail: `Deleted alert ${id}`,
      metadata: { alert_id: id },
    })
    emitSync('security_alerts_changed', { action: 'delete_one', alert_id: id })
    emitSync('security_logs_changed', { action: 'delete_one_alert', alert_id: id })
    return res.status(204).send()
  } catch (e) {
    console.error('[security-suite] alert delete', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/settings/security-suite/alerts/bulk-delete', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    console.log('[security-suite] alert bulk-delete request', {
      all: b.all === true,
      idsCount: Array.isArray(b.ids) ? b.ids.length : 0,
    })
    if (b.all === true) {
      const out = await pool.query(
        `DELETE FROM security_events WHERE status IN ('failed', 'blocked', 'warning', 'pending')`,
      )
      const deleted = Number(out.rowCount) || 0
      console.log('[security-suite] alert bulk-delete result', { deleted, mode: 'all' })
      if (deleted > 0) {
        await logSecurityEvent(pool, {
          actor: adminActor(req),
          eventType: 'Security alerts cleared',
          status: 'completed',
          detail: `Deleted ${deleted} active security alerts`,
          metadata: { deleted, mode: 'all' },
        })
        emitSync('security_alerts_changed', { action: 'bulk_delete', deleted, mode: 'all' })
        emitSync('security_logs_changed', { action: 'bulk_delete_alerts', deleted, mode: 'all' })
      }
      return res.json({ ok: true, deleted })
    }
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => text(x, 64)).filter(Boolean) : []
    if (ids.length === 0) return res.status(400).json({ error: 'ids or all=true required' })
    const out = await pool.query(`DELETE FROM security_events WHERE id = ANY($1::uuid[])`, [ids])
    const deleted = Number(out.rowCount) || 0
    console.log('[security-suite] alert bulk-delete result', { deleted, mode: 'ids' })
    if (deleted > 0) {
      await logSecurityEvent(pool, {
        actor: adminActor(req),
        eventType: 'Security alerts cleared',
        status: 'completed',
        detail: `Deleted ${deleted} selected security alerts`,
        metadata: { deleted, mode: 'ids' },
      })
      emitSync('security_alerts_changed', { action: 'bulk_delete', deleted, mode: 'ids' })
      emitSync('security_logs_changed', { action: 'bulk_delete_alerts', deleted, mode: 'ids' })
    }
    return res.json({ ok: true, deleted })
  } catch (e) {
    console.error('[security-suite] alert bulk-delete', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.get('/security-logs', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const { rows } = await pool.query(
      `SELECT id, actor, event_type, status, detail, created_at
       FROM security_events
       ORDER BY created_at DESC
       LIMIT 1000`,
    )
    return res.json(
      rows.map((r) => ({
        id: String(r.id),
        actor: String(r.actor || ''),
        eventType: String(r.event_type || ''),
        status: String(r.status || 'completed'),
        detail: String(r.detail || ''),
        timestamp: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
      })),
    )
  } catch (e) {
    console.error('[security-logs] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.delete('/security-logs/:id', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const id = text(req.params.id, 64)
    console.log('[security-logs] delete request', { id })
    const { rowCount } = await pool.query(`DELETE FROM security_events WHERE id = $1::uuid`, [id])
    console.log('[security-logs] delete result', { id, deleted: Number(rowCount) || 0 })
    if (!rowCount) return res.status(404).json({ error: 'Security log not found' })
    emitSync('security_logs_changed', { action: 'delete_one', log_id: id })
    emitSync('security_alerts_changed', { action: 'delete_one_log', log_id: id })
    return res.status(204).send()
  } catch (e) {
    console.error('[security-logs] DELETE', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/security-logs/bulk-delete', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    console.log('[security-logs] bulk-delete request', {
      all: b.all === true,
      idsCount: Array.isArray(b.ids) ? b.ids.length : 0,
    })
    const all = b.all === true
    if (all) {
      const out = await pool.query(`DELETE FROM security_events`)
      const deleted = Number(out.rowCount) || 0
      console.log('[security-logs] bulk-delete result', { deleted, mode: 'all' })
      emitSync('security_logs_changed', { action: 'bulk_delete', deleted, mode: 'all' })
      emitSync('security_alerts_changed', { action: 'bulk_delete_logs', deleted, mode: 'all' })
      return res.json({ ok: true, deleted })
    }
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => text(x, 64)).filter(Boolean) : []
    if (ids.length === 0) return res.status(400).json({ error: 'ids or all=true required' })
    const out = await pool.query(`DELETE FROM security_events WHERE id = ANY($1::uuid[])`, [ids])
    const deleted = Number(out.rowCount) || 0
    console.log('[security-logs] bulk-delete result', { deleted, mode: 'ids' })
    emitSync('security_logs_changed', { action: 'bulk_delete', deleted, mode: 'ids' })
    emitSync('security_alerts_changed', { action: 'bulk_delete_logs', deleted, mode: 'ids' })
    return res.json({ ok: true, deleted })
  } catch (e) {
    console.error('[security-logs] bulk-delete', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/security-logs', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    await logSecurityEvent(pool, {
      actor: b.actor,
      eventType: b.eventType,
      status: b.status,
      detail: b.detail,
      metadata: b.metadata || {},
    })
    emitSync('security_logs_changed', { action: 'create' })
    if (['failed', 'blocked', 'warning', 'pending'].includes(String(b.status || ''))) {
      emitSync('security_alerts_changed', { action: 'create' })
    }
    return res.json({ ok: true })
  } catch (e) {
    console.error('[security-logs] POST', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.get('/transfer-codes', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    await cleanupSecurity(pool)
    const { rows } = await pool.query(
      `SELECT id, code, source_device_id, status, created_at, expires_at, used_at, revoked_at
       FROM transfer_codes
       ORDER BY created_at DESC
       LIMIT 500`,
    )
    return res.json(
      rows.map((r) => ({
        id: String(r.id),
        code: String(r.code),
        deviceUser: String(r.source_device_id),
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        expiresAt: r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at),
        status: String(r.status),
      })),
    )
  } catch (e) {
    console.error('[transfer-codes] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/transfer-codes', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const sourceDeviceId = text(b.deviceUser ?? b.source_device_id, 128) || 'unassigned-device'
    let code = text(b.code, 32).toUpperCase()
    if (!code) code = randomTransferCode()
    const hoursFromNow = Math.max(1, Math.min(72, Number(b.hours) || TRANSFER_CODE_TTL_MINUTES / 60))
    const { rows } = await pool.query(
      `INSERT INTO transfer_codes (code, source_device_id, status, expires_at, created_by, created_at, updated_at)
       VALUES ($1, $2, 'active', now() + ($3::int * interval '1 hour'), $4, now(), now())
       RETURNING id, code, source_device_id, status, created_at, expires_at`,
      [code, sourceDeviceId, hoursFromNow, 'admin'],
    )
    const row = rows[0]
    emitSync('transfer_requested', {
      code: String(row.code),
      source_device_id: String(row.source_device_id),
      status: 'active',
    })
    await logSecurityEvent(pool, {
      actor: adminActor(req),
      eventType: 'Code transfer',
      status: 'completed',
      detail: `Issued transfer code ${row.code}`,
      metadata: { source_device_id: sourceDeviceId },
    })
    emitSync('transfer_codes_changed', { action: 'create', code: String(row.code) })
    emitSync('security_logs_changed', { action: 'transfer_code_create', code: String(row.code) })
    return res.status(201).json({
      id: String(row.id),
      code: String(row.code),
      deviceUser: String(row.source_device_id),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : String(row.expires_at),
      status: String(row.status),
    })
  } catch (e) {
    console.error('[transfer-codes] POST', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.put('/transfer-codes/:id', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const id = text(req.params.id, 64)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const status = ['active', 'used', 'revoked', 'expired'].includes(String(b.status))
      ? String(b.status)
      : 'active'
    const { rows } = await pool.query(
      `UPDATE transfer_codes
       SET status = $2,
           updated_at = now(),
           revoked_at = CASE WHEN $2 = 'revoked' THEN now() ELSE revoked_at END,
           used_at = CASE WHEN $2 = 'used' THEN now() ELSE used_at END
       WHERE id = $1
       RETURNING id, code, source_device_id, status, created_at, expires_at`,
      [id, status],
    )
    if (!rows[0]) return res.status(404).json({ error: 'Transfer code not found' })
    if (status === 'revoked' || status === 'expired') {
      await pool.query(
        `UPDATE device_transfers
         SET status = $2,
             reason = CASE
               WHEN $2 = 'revoked' THEN 'revoked_by_admin'
               ELSE 'code_expired'
             END
         WHERE code_id = $1::uuid
           AND status IN ('requested', 'awaiting_target_submission', 'pending_confirmation')`,
        [id, status],
      )
    }
    if (status === 'revoked') {
      await logSecurityEvent(pool, {
        actor: adminActor(req),
        eventType: 'Code transfer',
        status: 'completed',
        detail: `Revoked transfer code ${rows[0].code}`,
        metadata: { code: String(rows[0].code), transfer_code_id: id },
      })
      emitSync('transfer_rejected', { code: String(rows[0].code), reason: 'revoked_by_admin' })
      emitSync('security_logs_changed', { action: 'transfer_code_revoke', code: String(rows[0].code) })
    }
    emitSync('transfer_codes_changed', { action: 'update', code: String(rows[0].code), status })
    return res.json({
      id: String(rows[0].id),
      code: String(rows[0].code),
      deviceUser: String(rows[0].source_device_id),
      createdAt:
        rows[0].created_at instanceof Date ? rows[0].created_at.toISOString() : String(rows[0].created_at),
      expiresAt:
        rows[0].expires_at instanceof Date ? rows[0].expires_at.toISOString() : String(rows[0].expires_at),
      status: String(rows[0].status),
    })
  } catch (e) {
    console.error('[transfer-codes] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.delete('/transfer-codes/:id', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const id = text(req.params.id, 64)
    console.log('[transfer-codes] delete request', { id })
    const out = await pool.query(`DELETE FROM transfer_codes WHERE id = $1::uuid`, [id])
    console.log('[transfer-codes] delete result', { id, deleted: Number(out.rowCount) || 0 })
    if (!out.rowCount) return res.status(404).json({ error: 'Transfer code not found' })
    emitSync('transfer_codes_changed', { action: 'delete_one', transfer_code_id: id })
    return res.status(204).send()
  } catch (e) {
    console.error('[transfer-codes] DELETE', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/transfer-codes/bulk-delete', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    console.log('[transfer-codes] bulk-delete request', {
      all: b.all === true,
      expiredOnly: b.expiredOnly === true,
      idsCount: Array.isArray(b.ids) ? b.ids.length : 0,
    })
    const all = b.all === true
    const expiredOnly = b.expiredOnly === true
    if (all && expiredOnly) {
      const out = await pool.query(`DELETE FROM transfer_codes WHERE status = 'expired' OR expires_at <= now()`)
      const deleted = Number(out.rowCount) || 0
      console.log('[transfer-codes] bulk-delete result', { deleted, mode: 'expired' })
      emitSync('transfer_codes_changed', { action: 'bulk_delete', deleted, mode: 'expired' })
      return res.json({ ok: true, deleted })
    }
    if (all) {
      const out = await pool.query(`DELETE FROM transfer_codes`)
      const deleted = Number(out.rowCount) || 0
      console.log('[transfer-codes] bulk-delete result', { deleted, mode: 'all' })
      emitSync('transfer_codes_changed', { action: 'bulk_delete', deleted, mode: 'all' })
      return res.json({ ok: true, deleted })
    }
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => text(x, 64)).filter(Boolean) : []
    if (ids.length === 0) return res.status(400).json({ error: 'ids or all=true required' })
    const out = await pool.query(`DELETE FROM transfer_codes WHERE id = ANY($1::uuid[])`, [ids])
    const deleted = Number(out.rowCount) || 0
    console.log('[transfer-codes] bulk-delete result', { deleted, mode: 'ids' })
    emitSync('transfer_codes_changed', { action: 'bulk_delete', deleted, mode: 'ids' })
    return res.json({ ok: true, deleted })
  } catch (e) {
    console.error('[transfer-codes] bulk-delete', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/transfer/request', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    await cleanupSecurity(pool)

    const livePolicy = await readTransferSettingsLive(pool)

    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const sourceDeviceId = text(b.source_device_id ?? b.device_id, 128)
    const paymentPhone = text(b.payment_phone ?? b.phone, 40)
    if (!sourceDeviceId || !paymentPhone) {
      return res.status(400).json({ error: 'source_device_id and payment_phone are required' })
    }
    const ownerDeviceId = await billing.findActiveDeviceIdForPaymentPhone(paymentPhone)
    if (!ownerDeviceId) return res.status(404).json({ error: 'No active subscription found for this payment phone' })
    let effectiveSourceId = ownerDeviceId
    if (ownerDeviceId !== sourceDeviceId) {
      const linked = await billing.isDeviceLinkedToPaymentPhone(sourceDeviceId, paymentPhone)
      if (!linked) {
        return res.status(403).json({
          error: 'Requesting device is not the active subscription owner for this payment phone',
        })
      }
    }
    const sourceSub = await resolveSubscriptionByDevice(pool, effectiveSourceId)
    if (!sourceSub || sourceSub.status !== 'active') {
      return res.status(400).json({ error: 'Source subscription is not active' })
    }
    const validSubRes = await pool.query(
      `SELECT (status = 'active' AND expires_at > now()) AS active FROM device_subscriptions WHERE device_id = $1`,
      [effectiveSourceId],
    )
    if (!validSubRes.rows[0]?.active) {
      return res.status(400).json({ error: 'Source subscription expired' })
    }
    const fpHash = fingerprintHash(b.target_fingerprint || b.fingerprint)
    console.log('[transfer/request] policy snapshot', {
      sourceDeviceId,
      cooldownMinutes: livePolicy.cooldownMinutes,
      dailyLimit: livePolicy.dailyLimit,
      weeklyLimit: livePolicy.weeklyLimit,
      persistedRows: livePolicy.dbRows,
    })
    const limits = await checkTransferLimits(
      pool,
      effectiveSourceId,
      livePolicy.cooldownMinutes,
      livePolicy.dailyLimit,
      livePolicy.weeklyLimit,
    )
    if (!limits.ok) {
      const isDaily = limits.reason === 'Daily transfer limit reached'
      const isWeekly = limits.reason === 'Weekly transfer limit reached'
      const isCooldown = limits.reason === 'Transfer cooldown active'
      const reasonCode =
        isDaily ? 'TRANSFER_DAILY_LIMIT' : isWeekly ? 'TRANSFER_WEEKLY_LIMIT' : isCooldown ? 'cooldown_active' : 'transfer_rejected'
      await logSecurityEvent(pool, {
        actor: sourceDeviceId,
        eventType: 'Transfer request',
        status: 'failed',
        detail: limits.reason,
        metadata: { source_device_id: sourceDeviceId, reason: reasonCode },
      })
      emitSync('security_logs_changed', { action: 'transfer_request_failed', source_device_id: sourceDeviceId })
      emitSync('security_alerts_changed', { action: 'transfer_request_failed', source_device_id: sourceDeviceId })
      if (isCooldown) {
        console.warn('[transfer/request] rejected: cooldown active', {
          sourceDeviceId,
          retryAfterSec: limits.retryAfterSec,
          cooldownUntilMs: limits.cooldownUntilMs,
          dayCount: limits.dayCount,
          weekCount: limits.weekCount,
        })
        const responseBody = {
          ok: false,
          code: reasonCode,
          error: limits.reason,
          retryAfterSec: limits.retryAfterSec || null,
          cooldownUntilMs: limits.cooldownUntilMs || null,
        }
        console.log('[transfer/request] response body', responseBody)
        return res.status(429).json(responseBody)
      }
      if (isDaily) {
        console.warn('[transfer/request] rejected: daily limit reached', {
          sourceDeviceId,
          dayCount: limits.dayCount,
          dailyLimit: livePolicy.dailyLimit,
          weekCount: limits.weekCount,
        })
      }
      if (isWeekly) {
        console.warn('[transfer/request] rejected: weekly limit reached', {
          sourceDeviceId,
          weekCount: limits.weekCount,
          weeklyLimit: livePolicy.weeklyLimit,
          dayCount: limits.dayCount,
        })
      }
      if (isDaily || isWeekly) {
        const responseBody = {
          ok: false,
          code: reasonCode,
          error: TRANSFER_LIMIT_FORBIDDEN_MESSAGE,
        }
        console.log('[transfer/request] response body', responseBody)
        return res.status(403).json(responseBody)
      }
      const responseBody = {
        ok: false,
        code: reasonCode,
        error: limits.reason,
      }
      console.log('[transfer/request] response body', responseBody)
      return res.status(429).json(responseBody)
    }
    console.log('[transfer/request] policy counters pass', {
      sourceDeviceId,
      dayCount: limits.dayCount,
      weekCount: limits.weekCount,
    })
    const generatedCode = randomTransferCode()
    const { rows } = await pool.query(
      `INSERT INTO transfer_codes
       (code, source_device_id, target_device_id, target_fingerprint_hash, status, expires_at, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now() + ($5::int * interval '1 minute'), 'device', now(), now())
       RETURNING id, code, expires_at`,
      [generatedCode, effectiveSourceId, null, fpHash, TRANSFER_CODE_TTL_MINUTES],
    )
    await pool.query(
      `INSERT INTO device_transfers
       (code_id, code, source_device_id, target_device_id, source_fingerprint_hash, target_fingerprint_hash, status, reason, requested_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'requested', 'code_issued', 'device', now())`,
      [rows[0].id, rows[0].code, effectiveSourceId, 'pending-target', null, fpHash],
    )
    await logSecurityEvent(pool, {
      actor: sourceDeviceId,
      eventType: 'Transfer request',
      status: 'completed',
      detail: 'Transfer code issued',
      metadata: { source_device_id: effectiveSourceId, code: rows[0].code },
    })
    const responseBody = {
      ok: true,
      code: String(rows[0].code),
      expires_at: rows[0].expires_at instanceof Date ? rows[0].expires_at.toISOString() : String(rows[0].expires_at),
      transfer_mode: livePolicy.transferMode,
      source_device_id: effectiveSourceId,
    }
    emitSync('transfer_requested', {
      code: responseBody.code,
      source_device_id: sourceDeviceId,
      status: 'active',
      transfer_mode: livePolicy.transferMode,
    })
    emitSync('transfer_codes_changed', { action: 'request', code: responseBody.code, source_device_id: sourceDeviceId })
    emitSync('security_logs_changed', { action: 'transfer_request', source_device_id: sourceDeviceId })
    console.log('[transfer/request] response body', responseBody)
    return res.json(responseBody)
  } catch (e) {
    console.error('[transfer/request]', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/transfer/confirm', async (req, res) => {
  const pool = getPool()
  if (!pool) return res.status(503).json({ error: 'Database not configured' })
  await ensureSecurityTables(pool)
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  const code = text(b.code, 32).toUpperCase()
  const targetDeviceId = text(b.target_device_id ?? b.device_id, 128)
  const targetFpHash = fingerprintHash(b.target_fingerprint || b.fingerprint)
  if (!code || !targetDeviceId) {
    return res.status(400).json({ error: 'code and target_device_id are required' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const codeRowRes = await client.query(
      `SELECT *
       FROM transfer_codes
       WHERE code = $1
       FOR UPDATE`,
      [code],
    )
    const codeRow = codeRowRes.rows[0]
    if (!codeRow) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Invalid transfer code' })
    }
    if (codeRow.status !== 'active') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Transfer code not active' })
    }
    const sourceDeviceId = String(codeRow.source_device_id || '').trim()
    if (!sourceDeviceId) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Transfer code missing source device' })
    }
    if (sourceDeviceId === targetDeviceId) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Target device must differ from source device' })
    }
    const expRes = await client.query(`SELECT now() < $1::timestamptz AS valid`, [codeRow.expires_at])
    if (!expRes.rows[0]?.valid) {
      await client.query(
        `UPDATE transfer_codes SET status = 'expired', updated_at = now() WHERE id = $1`,
        [codeRow.id],
      )
      await client.query('COMMIT')
      return res.status(400).json({ error: 'Transfer code expired' })
    }
    const sourceSub = await client.query(
      `SELECT *
       FROM device_subscriptions
       WHERE device_id = $1
       FOR UPDATE`,
      [sourceDeviceId],
    )
    const sub = sourceSub.rows[0]
    if (!sub) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Source subscription not found' })
    }
    const validSubRes = await client.query(
      `SELECT (status = 'active' AND expires_at > now()) AS active FROM device_subscriptions WHERE device_id = $1`,
      [sourceDeviceId],
    )
    if (!validSubRes.rows[0]?.active) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Source subscription expired' })
    }

    const livePolicy = await readTransferSettingsLive(client)

    if (livePolicy.transferMode === 'confirmation') {
      const pendingCode = await client.query(
        `UPDATE transfer_codes
         SET status = 'pending_confirmation',
             target_device_id = $2,
             target_fingerprint_hash = COALESCE($3, target_fingerprint_hash),
             updated_at = now()
         WHERE id = $1
         RETURNING id, code, expires_at`,
        [codeRow.id, targetDeviceId, targetFpHash],
      )
      if (!pendingCode.rows[0]) {
        await client.query('ROLLBACK')
        return res.status(500).json({ error: 'Transfer code update failed' })
      }
      const transferRow = await client.query(
        `UPDATE device_transfers
         SET status = 'pending_confirmation',
             target_device_id = $2,
             target_fingerprint_hash = COALESCE($3, target_fingerprint_hash),
             reason = 'awaiting_source_approval'
         WHERE code_id = $1
         RETURNING id`,
        [codeRow.id, targetDeviceId, targetFpHash],
      )
      if ((transferRow.rowCount || 0) === 0) {
        await client.query(
          `INSERT INTO device_transfers
           (code_id, code, source_device_id, target_device_id, source_fingerprint_hash, target_fingerprint_hash, status, reason, requested_by, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'pending_confirmation', 'awaiting_source_approval', 'device', now())`,
          [codeRow.id, code, sourceDeviceId, targetDeviceId, sub.fingerprint_hash || null, targetFpHash],
        )
      }
      await logSecurityEvent(client, {
        actor: targetDeviceId,
        eventType: 'Transfer confirmation pending',
        status: 'pending',
        detail: `Awaiting source approval for ${sourceDeviceId}`,
        metadata: { code, source_device_id: sourceDeviceId, target_device_id: targetDeviceId },
      })
      await client.query('COMMIT')
      const transferId = transferRow.rows[0]?.id ? String(transferRow.rows[0].id) : String(codeRow.id)
      publishTransferConfirmationRequired({
        sourceDeviceId,
        targetDeviceId,
        code,
        transferId,
        expiresAt: codeRow.expires_at,
      })
      emitSync('security_logs_changed', {
        action: 'transfer_pending_confirmation',
        source_device_id: sourceDeviceId,
        target_device_id: targetDeviceId,
      })
      return res.json({
        ok: true,
        pending_confirmation: true,
        requires_source_approval: true,
        transfer_mode: 'confirmation',
        code,
        source_device_id: sourceDeviceId,
        target_device_id: targetDeviceId,
        transfer_id: transferId,
      })
    }

    const move = await commitSubscriptionTransfer(client, {
      sourceDeviceId,
      targetDeviceId,
      targetFpHash,
      code,
      transactionPrefix: 'transfer',
      transferReason: 'confirmed_by_code',
      notifyReason: 'transfer_confirm',
      userInitiatedTransfer: true,
    })
    if (!move.ok) {
      await client.query('ROLLBACK')
      return res.status(move.status || 500).json({ error: move.error })
    }
    const markCodeUsed = await client.query(
      `UPDATE transfer_codes
       SET status = 'used',
           target_device_id = $2,
           target_fingerprint_hash = COALESCE($3, target_fingerprint_hash),
           used_at = COALESCE(used_at, now()),
           updated_at = now()
       WHERE id = $1
       RETURNING id, status, target_device_id`,
      [codeRow.id, targetDeviceId, targetFpHash],
    )
    if (!markCodeUsed.rows[0]) {
      await client.query('ROLLBACK')
      return res.status(500).json({ error: 'Transfer code update failed' })
    }
    const updatedTransfers = await client.query(
      `UPDATE device_transfers
       SET status = 'completed',
           completed_at = now(),
           target_device_id = $2,
           target_fingerprint_hash = COALESCE($3, target_fingerprint_hash),
           reason = 'confirmed_by_code'
       WHERE code_id = $1`,
      [codeRow.id, targetDeviceId, targetFpHash],
    )
    if ((updatedTransfers.rowCount || 0) === 0) {
      await client.query(
        `INSERT INTO device_transfers
         (code_id, code, source_device_id, target_device_id, source_fingerprint_hash, target_fingerprint_hash, status, reason, requested_by, created_at, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'completed', 'confirmed_by_code', 'device', now(), now())`,
        [codeRow.id, code, sourceDeviceId, targetDeviceId, sub.fingerprint_hash || null, targetFpHash],
      )
    }
    await logSecurityEvent(client, {
      actor: sourceDeviceId,
      eventType: 'Transfer confirmation',
      status: 'completed',
      detail: `Transferred to ${targetDeviceId}`,
      metadata: {
        code,
        source_device_id: sourceDeviceId,
        target_device_id: targetDeviceId,
        transfer_mode: 'manual',
      },
    })
    await client.query('COMMIT')
    publishTransferRealtime({
      sourceDeviceId,
      targetDeviceId,
      sourceAfter: move.sourceAfter,
      targetAfter: move.targetAfter,
      reason: 'transfer_confirm',
      userInitiatedTransfer: true,
      syncReason: 'confirmed_by_code',
    })
    return res.json({
      ok: true,
      source_device_id: sourceDeviceId,
      target_device_id: targetDeviceId,
      transferred: true,
      transfer_mode: 'manual',
      source_active_after: false,
      target_active_after: true,
      expires_at: move.expiresAt instanceof Date ? move.expiresAt.toISOString() : String(move.expiresAt),
    })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[transfer/confirm]', e)
    return res.status(500).json({ error: String(e.message || e) })
  } finally {
    client.release()
  }
})

deviceSecurityRouter.post('/transfer/respond', async (req, res) => {
  const pool = getPool()
  if (!pool) return res.status(503).json({ error: 'Database not configured' })
  await ensureSecurityTables(pool)
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  const code = text(b.code, 32).toUpperCase()
  const sourceDeviceId = text(b.source_device_id ?? b.device_id, 128)
  const decision = String(b.decision ?? b.action ?? '').trim().toLowerCase()
  if (!code || !sourceDeviceId) {
    return res.status(400).json({ error: 'code and source_device_id are required' })
  }
  if (!['approve', 'reject', 'accepted', 'declined'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approve or reject' })
  }
  const approved = decision === 'approve' || decision === 'accepted'
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const codeRowRes = await client.query(
      `SELECT * FROM transfer_codes WHERE code = $1 FOR UPDATE`,
      [code],
    )
    const codeRow = codeRowRes.rows[0]
    if (!codeRow) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Invalid transfer code' })
    }
    if (String(codeRow.source_device_id) !== sourceDeviceId) {
      await client.query('ROLLBACK')
      return res.status(403).json({ error: 'Source device does not match transfer code' })
    }
    if (codeRow.status === 'used') {
      await client.query('ROLLBACK')
      return res.json({ ok: true, already_completed: true, transferred: true })
    }
    if (codeRow.status === 'revoked' || codeRow.status === 'expired') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Transfer code is no longer valid' })
    }
    if (codeRow.status !== 'pending_confirmation') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Transfer is not awaiting source approval' })
    }
    const targetDeviceId = String(codeRow.target_device_id || '').trim()
    if (!targetDeviceId) {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Transfer missing target device' })
    }
    if (!approved) {
      await client.query(
        `UPDATE transfer_codes SET status = 'revoked', revoked_at = now(), updated_at = now() WHERE id = $1`,
        [codeRow.id],
      )
      await client.query(
        `UPDATE device_transfers SET status = 'rejected', reason = 'source_rejected', completed_at = now()
         WHERE code_id = $1`,
        [codeRow.id],
      )
      await logSecurityEvent(client, {
        actor: sourceDeviceId,
        eventType: 'Transfer rejected',
        status: 'completed',
        detail: `Source rejected transfer to ${targetDeviceId}`,
        metadata: { code, source_device_id: sourceDeviceId, target_device_id: targetDeviceId },
      })
      await client.query('COMMIT')
      emitSync('transfer_rejected', { source_device_id: sourceDeviceId, target_device_id: targetDeviceId, code })
      emitSync('security_logs_changed', { action: 'transfer_rejected', source_device_id: sourceDeviceId })
      return res.json({ ok: true, rejected: true, transferred: false })
    }
    const move = await commitSubscriptionTransfer(client, {
      sourceDeviceId,
      targetDeviceId,
      targetFpHash: codeRow.target_fingerprint_hash,
      code,
      transactionPrefix: 'transfer',
      transferReason: 'source_approved',
      notifyReason: 'transfer_confirm',
      userInitiatedTransfer: true,
    })
    if (!move.ok) {
      await client.query('ROLLBACK')
      return res.status(move.status || 500).json({ error: move.error })
    }
    await client.query(
      `UPDATE transfer_codes SET status = 'used', used_at = now(), updated_at = now() WHERE id = $1`,
      [codeRow.id],
    )
    await client.query(
      `UPDATE device_transfers SET status = 'completed', completed_at = now(), reason = 'source_approved'
       WHERE code_id = $1`,
      [codeRow.id],
    )
    await logSecurityEvent(client, {
      actor: sourceDeviceId,
      eventType: 'Transfer approved',
      status: 'completed',
      detail: `Source approved transfer to ${targetDeviceId}`,
      metadata: { code, source_device_id: sourceDeviceId, target_device_id: targetDeviceId },
    })
    await client.query('COMMIT')
    publishTransferRealtime({
      sourceDeviceId,
      targetDeviceId,
      sourceAfter: move.sourceAfter,
      targetAfter: move.targetAfter,
      reason: 'transfer_confirm',
      userInitiatedTransfer: true,
      syncReason: 'source_approved',
    })
    return res.json({
      ok: true,
      transferred: true,
      source_device_id: sourceDeviceId,
      target_device_id: targetDeviceId,
      expires_at: move.expiresAt instanceof Date ? move.expiresAt.toISOString() : String(move.expiresAt),
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[transfer/respond]', e)
    return res.status(500).json({ error: String(e.message || e) })
  } finally {
    client.release()
  }
})

deviceSecurityRouter.get('/transfer/status', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const code = text(req.query.code, 32).toUpperCase()
    const deviceId = text(req.query.device_id, 128)
    if (!code && !deviceId) return res.status(400).json({ error: 'code or device_id required' })
    let row
    if (code) {
      const { rows } = await pool.query(
        `SELECT tc.*, dt.status AS transfer_status, dt.completed_at
         FROM transfer_codes tc
         LEFT JOIN device_transfers dt ON dt.code_id = tc.id
         WHERE tc.code = $1
         ORDER BY dt.created_at DESC NULLS LAST
         LIMIT 1`,
        [code],
      )
      row = rows[0]
    } else {
      const { rows } = await pool.query(
        `SELECT tc.*, dt.status AS transfer_status, dt.completed_at
         FROM transfer_codes tc
         LEFT JOIN device_transfers dt ON dt.code_id = tc.id
         WHERE tc.source_device_id = $1 OR tc.target_device_id = $1
         ORDER BY tc.created_at DESC
         LIMIT 1`,
        [deviceId],
      )
      row = rows[0]
    }
    if (!row) return res.status(404).json({ error: 'Transfer not found' })
    const livePolicy = await readTransferSettingsLive(pool)
    return res.json({
      ok: true,
      code: String(row.code),
      status: String(row.status),
      transfer_status: String(row.transfer_status || row.status),
      source_device_id: String(row.source_device_id || ''),
      target_device_id: String(row.target_device_id || ''),
      expires_at: row.expires_at,
      transfer_mode: livePolicy.transferMode,
      requires_source_approval: row.status === 'pending_confirmation',
      completed_at: row.completed_at ?? row.used_at ?? null,
    })
  } catch (e) {
    console.error('[transfer/status]', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/transfer/admin-force', requireAdminPanelAccess, async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = sensitiveActionPasswordFromBody(req)
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ error: 'Invalid security PIN' })
    }
    const sourceDeviceId = text(b.source_device_id, 128)
    const targetDeviceId = text(b.target_device_id, 128)
    const targetFpHash = fingerprintHash(b.target_fingerprint || b.fingerprint)
    const result = await executeAdminForceTransfer(pool, {
      sourceDeviceId,
      targetDeviceId,
      targetFpHash,
      actor: adminActor(req),
      auditExtra: '',
      idempotencyKey: text(b.idempotency_key ?? b.idempotencyKey, 128),
    })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    return res.json({ ok: true, source_device_id: result.source_device_id, target_device_id: result.target_device_id })
  } catch (e) {
    console.error('[transfer/admin-force]', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/transfer/admin-force-phone', requireAdminPanelAccess, async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = sensitiveActionPasswordFromBody(req)
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ error: 'Invalid security PIN' })
    }
    const paymentPhone = text(b.payment_phone ?? b.phone, 40)
    const targetDeviceId = text(b.target_device_id ?? b.new_device_id, 128)
    if (!paymentPhone || !targetDeviceId) {
      return res.status(400).json({ error: 'payment_phone and target_device_id are required' })
    }
    const sourceDeviceId = await billing.findActiveDeviceIdForPaymentPhone(paymentPhone)
    if (!sourceDeviceId) {
      return res.status(404).json({ error: 'No active subscription found for this payment phone' })
    }
    const targetFpHash = fingerprintHash(b.target_fingerprint || b.fingerprint)
    const digits = billing.normalizePhoneDigits(paymentPhone)
    const auditExtra = digits ? `payment_phone_digits:${digits}` : ''
    const result = await executeAdminForceTransfer(pool, {
      sourceDeviceId,
      targetDeviceId,
      targetFpHash,
      actor: adminActor(req),
      auditExtra,
      idempotencyKey: text(b.idempotency_key ?? b.idempotencyKey, 128),
    })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    return res.json({
      ok: true,
      source_device_id: result.source_device_id,
      target_device_id: result.target_device_id,
      resolved_from_payment_phone: true,
    })
  } catch (e) {
    console.error('[transfer/admin-force-phone]', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/subscription/recover', async (req, res) => {
  const pool = getPool()
  const client = (await pool?.connect?.()) || null
  try {
    if (!pool || !client) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(client)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = text(b.device_id, 128)
    if (!deviceId) return res.status(400).json({ error: 'device_id is required' })
    const legacyDeviceId = text(
      b.legacy_device_id ??
        b.previous_device_id ??
        b.source_device_id ??
        b.displayed_account_id ??
        '',
      128,
    )
    const accountId = text(b.account_id ?? b.accountId ?? '', 64)
    const paymentPhone = text(b.payment_phone ?? b.phone ?? '', 32)
    const fingerprint = text(b.fingerprint ?? b.device_fingerprint ?? '', 512)

    const link = await ensureSubscriptionLinkedForDevice(deviceId, {
      fingerprint: fingerprint || null,
      phone: paymentPhone || null,
      legacyDeviceId: legacyDeviceId || null,
      accountId: accountId || null,
    }).catch(() => ({ linked: false }))
    if (link.linked) {
      const row = await billing.getDeviceSubscriptionAccessState(deviceId, fingerprint)
      return res.json({
        ok: true,
        method: link.method,
        recovered_from: link.recovered_from ?? null,
        active: row?.active_now === true,
        expires_at: row?.expires_at ?? null,
      })
    }

    return res.status(403).json({
      ok: false,
      error: 'Automatic cross-device subscription recovery is disabled. Use Hamisha Kifurushi or Admin transfer.',
      reason: link.reason || 'automatic_cross_device_migration_disabled',
    })
  } catch (e) {
    if (client) await client.query('ROLLBACK').catch(() => {})
    console.error('[subscription/recover]', e)
    return res.status(500).json({ error: String(e.message || e) })
  } finally {
    if (client) client.release()
  }
})

deviceSecurityRouter.post('/subscription/revoke', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = text(b.device_id, 128)
    if (!deviceId) return res.status(400).json({ error: 'device_id is required' })
    const { revokeAdminDeviceSubscription, insertAdminRevocationAudit } = await import(
      '../lib/adminSubscriptionRevocation.js'
    )
    const { invalidateSubscriptionAccessCache } = await import('../lib/subscriptionAccessCache.js')
    const client = await pool.connect()
    let result
    try {
      await client.query('BEGIN')
      result = await revokeAdminDeviceSubscription({
        deviceId,
        adminIdentity: 'security_console',
        reason: String(b.reason ?? 'security_revoke'),
        client,
      })
      if (result.ok && result.revoked) {
        await insertAdminRevocationAudit(client, {
          deviceId,
          adminIdentity: 'security_console',
          reason: String(b.reason ?? 'security_revoke'),
          transactionId: result.transaction_id,
        })
      }
      await client.query('COMMIT')
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {})
      throw e
    } finally {
      client.release()
    }
    if (result.notFound) return res.status(404).json({ error: 'Subscription not found' })
    const { notifyAdminSubscriptionRevoked } = await import('../lib/adminSubscriptionRevocation.js')
    notifyAdminSubscriptionRevoked(deviceId, result.transaction_id)
    await logSecurityEvent(pool, {
      actor: 'Admin',
      eventType: 'Subscription revoked',
      status: 'completed',
      detail: `Revoked subscription for ${deviceId}`,
      metadata: { device_id: deviceId, transaction_preserved: true },
    })
    notifySubscriptionTransferred({
      targetDeviceId: deviceId,
      targetRow: {
        device_id: deviceId,
        status: 'revoked',
        active_now: false,
      },
      reason: 'admin_revoked',
    })
    emitSync('subscription_revoked', {
      device_id: deviceId,
      deviceId,
      reason: 'admin_revoked',
      inactive_reason: 'admin_revoked',
      suppress_expiry_popup: true,
    })
    emitSync('security_logs_changed', { action: 'revoke', device_id: deviceId })
    return res.json({
      ok: true,
      device_id: deviceId,
      revoked: result.revoked === true || result.alreadyRevoked === true,
      idempotent: result.idempotent === true,
      transactions_preserved: true,
    })
  } catch (e) {
    console.error('[subscription/revoke]', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

setInterval(() => {
  const pool = getPool()
  if (!pool) return
  void cleanupSecurity(pool).catch((e) => console.error('[security-cleanup]', e))
}, 60_000)
