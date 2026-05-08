import crypto from 'node:crypto'
import { Router } from 'express'
import * as billing from '../billingStore.js'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'

export const deviceSecurityRouter = Router()

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

async function saveAppSettings(pool, entries) {
  for (const [k, v] of Object.entries(entries)) {
    await pool.query(
      `INSERT INTO app_settings (key, value, updated_at)
       VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [k, String(v ?? '')],
    )
  }
}

async function readAppSettings(pool, defaults) {
  const keys = Object.keys(defaults)
  const { rows } = await pool.query(`SELECT key, value FROM app_settings WHERE key = ANY($1::text[])`, [keys])
  const out = { ...defaults }
  for (const row of rows) out[String(row.key)] = String(row.value ?? '')
  return out
}

async function logSecurityEvent(pool, { actor, eventType, status, detail, metadata = {} }) {
  await pool.query(
    `INSERT INTO security_events (actor, event_type, status, detail, metadata, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, now())`,
    [text(actor, 120), text(eventType, 120), text(status, 32), text(detail, 2000), metadata || {}],
  )
}

function emitSync(event, payload) {
  liveSyncBus.publish(event, { topics: ['config'], ...payload })
}

function emitTransferScoped(event, payload) {
  if (event === 'transfer_confirmation_required') {
    console.log('[transfer-sse] emit transfer_confirmation_required', {
      source_device_id: payload?.source_device_id || null,
      target_device_id: payload?.target_device_id || null,
      pending_transfer_id: payload?.pending_transfer_id || null,
      code: payload?.code || null,
    })
  }
  emitSync(event, { scope: 'device', ...payload })
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
       COUNT(*) FILTER (WHERE created_at >= now() - interval '1 day')::int AS day_count,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '7 day')::int AS week_count,
       MAX(created_at) AS last_at
     FROM device_transfers
     WHERE source_device_id = $1
       AND status = 'completed'`,
    [sourceDeviceId],
  )
  const r = rows[0] || {}
  const dayCount = Number(r.day_count) || 0
  const weekCount = Number(r.week_count) || 0
  const lastAt = r.last_at ? new Date(r.last_at).getTime() : null
  const cooldownMs = cooldownMinutes * 60 * 1000
  const nowMs = Date.now()
  if (dayCount >= dailyLimit) return { ok: false, reason: 'Daily transfer limit reached' }
  if (weekCount >= weeklyLimit) return { ok: false, reason: 'Weekly transfer limit reached' }
  if (lastAt && nowMs - lastAt < cooldownMs) return { ok: false, reason: 'Transfer cooldown active' }
  return { ok: true }
}

/** Shared admin force transfer by device IDs. Emits SSE + subscription bus after commit. */
async function executeAdminForceTransfer(pool, { sourceDeviceId, targetDeviceId, targetFpHash, auditExtra }) {
  const src = text(sourceDeviceId, 128)
  const tgt = text(targetDeviceId, 128)
  if (!src || !tgt) return { ok: false, status: 400, error: 'source_device_id and target_device_id are required' }
  if (src === tgt) return { ok: false, status: 400, error: 'Source and target device must differ' }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const sourceSub = await client.query(
      `SELECT * FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`,
      [src],
    )
    const sub = sourceSub.rows[0]
    if (!sub) {
      await client.query('ROLLBACK')
      return { ok: false, status: 404, error: 'Source subscription not found' }
    }
    const validSubRes = await client.query(
      `SELECT (status = 'active' AND expires_at > now()) AS active FROM device_subscriptions WHERE device_id = $1`,
      [src],
    )
    if (!validSubRes.rows[0]?.active) {
      await client.query('ROLLBACK')
      return { ok: false, status: 400, error: 'Source subscription expired' }
    }
    const code = randomTransferCode()
    await client.query(
      `INSERT INTO transfer_codes
       (code, source_device_id, target_device_id, target_fingerprint_hash, status, expires_at, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'used', now() + interval '10 minutes', 'admin_force', now(), now())`,
      [code, src, tgt, targetFpHash],
    )
    await client.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash)
       VALUES ($1, 'active', $2, now(), $3, now(), $4)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         fingerprint_hash = COALESCE(EXCLUDED.fingerprint_hash, device_subscriptions.fingerprint_hash)`,
      [tgt, sub.expires_at, `force:${code}`, targetFpHash],
    )
    await client.query(
      `UPDATE device_subscriptions SET status = 'pending', updated_at = now() WHERE device_id = $1`,
      [src],
    )
    await client.query(
      `INSERT INTO device_transfers
       (code, source_device_id, target_device_id, source_fingerprint_hash, target_fingerprint_hash, status, reason, requested_by, created_at, completed_at)
       VALUES ($1, $2, $3, $4, $5, 'completed', 'admin_force', 'admin', now(), now())`,
      [code, src, tgt, sub.fingerprint_hash || null, targetFpHash],
    )
    const extra = auditExtra ? String(auditExtra).slice(0, 500) : ''
    await logSecurityEvent(client, {
      actor: 'Admin',
      eventType: 'Force transfer',
      status: 'completed',
      detail: `Force transferred ${src} -> ${tgt}${extra ? ` · ${extra}` : ''}`,
      metadata: { source_device_id: src, target_device_id: tgt },
    })
    await client.query('COMMIT')
    deviceSubscriptionBus.emit('update', { deviceId: src })
    deviceSubscriptionBus.emit('update', { deviceId: tgt })
    emitSync('transfer_completed', {
      source_device_id: src,
      target_device_id: tgt,
      reason: 'admin_force',
    })
    emitSync('subscription_revoked', { device_id: src, reason: 'admin_force' })
    return { ok: true, source_device_id: src, target_device_id: tgt }
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
    const defaults = {
      transfer_mode: 'confirmation',
      transfer_daily_limit: '5',
      transfer_weekly_limit: '15',
      transfer_cooldown_minutes: '60',
    }
    const values = await readAppSettings(pool, defaults)
    const pendingRows = await pool.query(
      `SELECT id, source_device_id, target_device_id, created_at, status
       FROM device_transfers
       WHERE status = 'requested'
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
    return res.json({
      transferMode: values.transfer_mode === 'manual' ? 'manual' : 'confirmation',
      dailyLimit: toInt(values.transfer_daily_limit, 5, 1, 1000),
      weeklyLimit: toInt(values.transfer_weekly_limit, 15, 1, 5000),
      cooldownMinutes: toInt(values.transfer_cooldown_minutes, 60, 1, 1440),
      pending: pendingRows.rows.map((r) => ({
        id: String(r.id),
        deviceLabel: `${r.source_device_id} -> ${r.target_device_id || 'pending'}`,
        requestedAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        status: String(r.status),
      })),
      logs: logsRows.rows.map((r) => ({
        id: String(r.id),
        at: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
        message: String(r.detail || ''),
      })),
    })
  } catch (e) {
    console.error('[device-control] GET', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.put('/settings/device-control', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const payload = {
      transferMode: String(b.transferMode || 'confirmation') === 'manual' ? 'manual' : 'confirmation',
      dailyLimit: toInt(b.dailyLimit, 5, 1, 1000),
      weeklyLimit: toInt(b.weeklyLimit, 15, 1, 5000),
      cooldownMinutes: toInt(b.cooldownMinutes, 60, 1, 1440),
    }
    await saveAppSettings(pool, {
      transfer_mode: payload.transferMode,
      transfer_daily_limit: payload.dailyLimit,
      transfer_weekly_limit: payload.weeklyLimit,
      transfer_cooldown_minutes: payload.cooldownMinutes,
    })
    emitSync('app_settings_changed', payload)
    return res.json({ ...payload, pending: b.pending || [], logs: b.logs || [] })
  } catch (e) {
    console.error('[device-control] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.get('/settings/security-suite', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
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
      `SELECT id, actor, detail, status, created_at, metadata
       FROM security_events
       WHERE status IN ('failed', 'blocked', 'warning')
       ORDER BY created_at DESC
       LIMIT 200`,
    )
    return res.json({
      protectionMode: 'automatic',
      whitelist: whitelistRows.rows.map((r) => ({ id: String(r.device_id), value: String(r.device_id) })),
      blockedUsers: blockedRows.rows.map((r) => ({
        id: String(r.device_id),
        value: String(r.device_id),
        reason: String(r.block_reason || ''),
      })),
      alerts: alertRows.rows.map((r) => ({
        id: String(r.id),
        title: String(r.actor || 'Security alert'),
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
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const whitelist = Array.isArray(b.whitelist) ? b.whitelist : []
    const blockedUsers = Array.isArray(b.blockedUsers) ? b.blockedUsers : []
    await pool.query('BEGIN')
    try {
      await pool.query(`UPDATE admin_devices SET whitelisted = false, updated_at = now() WHERE whitelisted = true`)
      for (const w of whitelist) {
        const deviceId = text(w?.value ?? w?.id, 128)
        if (!deviceId) continue
        await pool.query(
          `INSERT INTO admin_devices (device_id, whitelisted, updated_at)
           VALUES ($1, true, now())
           ON CONFLICT (device_id) DO UPDATE SET whitelisted = true, updated_at = now()`,
          [deviceId],
        )
      }
      await pool.query(`UPDATE admin_devices SET is_blocked = false, block_reason = NULL, updated_at = now()`)
      for (const bl of blockedUsers) {
        const deviceId = text(bl?.value ?? bl?.id, 128)
        if (!deviceId) continue
        await pool.query(
          `INSERT INTO admin_devices (device_id, is_blocked, block_reason, updated_at)
           VALUES ($1, true, $2, now())
           ON CONFLICT (device_id) DO UPDATE SET
             is_blocked = true,
             block_reason = EXCLUDED.block_reason,
             updated_at = now()`,
          [deviceId, text(bl?.reason, 500)],
        )
      }
      await pool.query('COMMIT')
    } catch (e) {
      await pool.query('ROLLBACK')
      throw e
    }
    emitSync('app_settings_changed', { section: 'security_suite' })
    return res.json({
      protectionMode: String(b.protectionMode || 'automatic'),
      whitelist,
      blockedUsers,
      alerts: Array.isArray(b.alerts) ? b.alerts : [],
    })
  } catch (e) {
    console.error('[security-suite] PUT', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/settings/security-suite/restore-whitelist', async (_req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const defaults = ['127.0.0.1', 'localhost']
    await pool.query(`UPDATE admin_devices SET whitelisted = false, updated_at = now() WHERE whitelisted = true`)
    for (const d of defaults) {
      await pool.query(
        `INSERT INTO admin_devices (device_id, whitelisted, updated_at)
         VALUES ($1, true, now())
         ON CONFLICT (device_id) DO UPDATE SET whitelisted = true, updated_at = now()`,
        [d],
      )
    }
    emitSync('app_settings_changed', { section: 'security_suite_whitelist' })
    return res.json({
      protectionMode: 'automatic',
      whitelist: defaults.map((v) => ({ id: v, value: v })),
      blockedUsers: [],
      alerts: [],
    })
  } catch (e) {
    console.error('[security-suite] restore whitelist', e)
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
      actor: 'Admin',
      eventType: 'Code transfer',
      status: 'completed',
      detail: `Issued transfer code ${row.code}`,
      metadata: { source_device_id: sourceDeviceId },
    })
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
    if (status === 'revoked') emitSync('transfer_rejected', { code: String(rows[0].code), reason: 'revoked_by_admin' })
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
    await pool.query(`DELETE FROM transfer_codes WHERE id = $1`, [id])
    return res.status(204).send()
  } catch (e) {
    console.error('[transfer-codes] DELETE', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/transfer/request', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    await cleanupSecurity(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const sourceDeviceId = text(b.source_device_id ?? b.device_id, 128)
    const paymentPhone = text(b.payment_phone ?? b.phone, 40)
    const targetDeviceId = text(b.target_device_id, 128) || null
    if (!sourceDeviceId || !paymentPhone) {
      return res.status(400).json({ error: 'source_device_id and payment_phone are required' })
    }
    const ownerDeviceId = await billing.findActiveDeviceIdForPaymentPhone(paymentPhone)
    if (!ownerDeviceId) return res.status(404).json({ error: 'No active subscription found for this payment phone' })
    if (ownerDeviceId !== sourceDeviceId) {
      return res.status(403).json({ error: 'Requesting device is not the active subscription owner for this payment phone' })
    }
    const sourceSub = await resolveSubscriptionByDevice(pool, sourceDeviceId)
    if (!sourceSub || sourceSub.status !== 'active') {
      return res.status(400).json({ error: 'Source subscription is not active' })
    }
    const validSubRes = await pool.query(
      `SELECT (status = 'active' AND expires_at > now()) AS active FROM device_subscriptions WHERE device_id = $1`,
      [sourceDeviceId],
    )
    if (!validSubRes.rows[0]?.active) {
      return res.status(400).json({ error: 'Source subscription expired' })
    }
    const fpHash = fingerprintHash(b.target_fingerprint || b.fingerprint)
    const cfg = await readAppSettings(pool, {
      transfer_mode: 'confirmation',
      transfer_daily_limit: '5',
      transfer_weekly_limit: '15',
      transfer_cooldown_minutes: '60',
    })
    const limits = await checkTransferLimits(
      pool,
      sourceDeviceId,
      toInt(cfg.transfer_cooldown_minutes, 60, 1, 1440),
      toInt(cfg.transfer_daily_limit, 5, 1, 1000),
      toInt(cfg.transfer_weekly_limit, 15, 1, 5000),
    )
    if (!limits.ok) {
      await logSecurityEvent(pool, {
        actor: sourceDeviceId,
        eventType: 'Transfer request',
        status: 'failed',
        detail: limits.reason,
        metadata: { source_device_id: sourceDeviceId, target_device_id: targetDeviceId },
      })
      emitTransferScoped('transfer_rejected', {
        source_device_id: sourceDeviceId,
        target_device_id: targetDeviceId,
        reason: limits.reason,
      })
      return res.status(429).json({ ok: false, error: limits.reason })
    }
    const generatedCode = randomTransferCode()
    const { rows } = await pool.query(
      `INSERT INTO transfer_codes
       (code, source_device_id, target_device_id, target_fingerprint_hash, status, expires_at, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, 'active', now() + ($5::int * interval '1 minute'), 'device', now(), now())
       RETURNING id, code, expires_at`,
      [generatedCode, sourceDeviceId, targetDeviceId, fpHash, TRANSFER_CODE_TTL_MINUTES],
    )
    await pool.query(
      `INSERT INTO device_transfers
       (code_id, code, source_device_id, target_device_id, source_fingerprint_hash, target_fingerprint_hash, status, reason, requested_by, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'requested', 'awaiting_target_submission', 'device', now())`,
      [rows[0].id, rows[0].code, sourceDeviceId, targetDeviceId, null, fpHash],
    )
    await pool.query(
      `UPDATE device_transfers
       SET status = 'awaiting_target_submission',
           reason = 'awaiting_target_submission'
       WHERE code_id = $1`,
      [rows[0].id],
    )
    await logSecurityEvent(pool, {
      actor: sourceDeviceId,
      eventType: 'Transfer request',
      status: 'completed',
      detail: `Transfer code issued for target ${targetDeviceId}`,
      metadata: { source_device_id: sourceDeviceId, target_device_id: targetDeviceId },
    })
    emitTransferScoped('transfer_requested', {
      source_device_id: sourceDeviceId,
      target_device_id: targetDeviceId,
      code: rows[0].code,
    })
    return res.json({
      ok: true,
      code: String(rows[0].code),
      expires_at: rows[0].expires_at instanceof Date ? rows[0].expires_at.toISOString() : String(rows[0].expires_at),
      transfer_mode: cfg.transfer_mode,
      source_device_id: sourceDeviceId,
    })
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
      emitTransferScoped('transfer_rejected', { code, reason: 'invalid_code', target_device_id: targetDeviceId })
      return res.status(404).json({ error: 'Invalid transfer code' })
    }
    if (codeRow.status !== 'active') {
      await client.query('ROLLBACK')
      emitTransferScoped('transfer_rejected', {
        code,
        reason: 'code_not_active',
        source_device_id: codeRow.source_device_id,
        target_device_id: targetDeviceId,
      })
      return res.status(400).json({ error: 'Transfer code not active' })
    }
    const expRes = await client.query(`SELECT now() < $1::timestamptz AS valid`, [codeRow.expires_at])
    if (!expRes.rows[0]?.valid) {
      await client.query(
        `UPDATE transfer_codes SET status = 'expired', updated_at = now() WHERE id = $1`,
        [codeRow.id],
      )
      await client.query('COMMIT')
      emitTransferScoped('transfer_rejected', {
        code,
        reason: 'code_expired',
        source_device_id: codeRow.source_device_id,
        target_device_id: targetDeviceId,
      })
      return res.status(400).json({ error: 'Transfer code expired' })
    }
    const sourceSub = await client.query(
      `SELECT *
       FROM device_subscriptions
       WHERE device_id = $1
       FOR UPDATE`,
      [codeRow.source_device_id],
    )
    const sub = sourceSub.rows[0]
    if (!sub) {
      await client.query('ROLLBACK')
      emitTransferScoped('transfer_rejected', {
        code,
        reason: 'source_subscription_missing',
        source_device_id: codeRow.source_device_id,
        target_device_id: targetDeviceId,
      })
      return res.status(404).json({ error: 'Source subscription not found' })
    }
    const validSubRes = await client.query(
      `SELECT (status = 'active' AND expires_at > now()) AS active FROM device_subscriptions WHERE device_id = $1`,
      [codeRow.source_device_id],
    )
    if (!validSubRes.rows[0]?.active) {
      await client.query('ROLLBACK')
      emitTransferScoped('transfer_rejected', {
        code,
        reason: 'source_subscription_expired',
        source_device_id: codeRow.source_device_id,
        target_device_id: targetDeviceId,
      })
      return res.status(400).json({ error: 'Source subscription expired' })
    }
    const pendingTransferRes = await client.query(
      `UPDATE device_transfers
       SET status = 'pending_confirmation',
           reason = 'awaiting_source_approval',
           target_device_id = $2,
           target_fingerprint_hash = COALESCE($3, target_fingerprint_hash)
       WHERE code_id = $1
       RETURNING id`,
      [codeRow.id, targetDeviceId, targetFpHash],
    )
    let pendingTransferId = String(pendingTransferRes.rows[0]?.id || '')
    if (!pendingTransferId) {
      const inserted = await client.query(
        `INSERT INTO device_transfers
         (code_id, code, source_device_id, target_device_id, source_fingerprint_hash, target_fingerprint_hash, status, reason, requested_by, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'pending_confirmation', 'awaiting_source_approval', 'device', now())
         RETURNING id`,
        [codeRow.id, codeRow.code, codeRow.source_device_id, targetDeviceId, sub.fingerprint_hash || null, targetFpHash],
      )
      pendingTransferId = String(inserted.rows[0]?.id || '')
    }
    await client.query(
      `UPDATE transfer_codes
       SET status = 'pending_confirmation',
           target_device_id = $2,
           target_fingerprint_hash = COALESCE($3, target_fingerprint_hash),
           used_at = now(),
           updated_at = now()
       WHERE id = $1`,
      [codeRow.id, targetDeviceId, targetFpHash],
    )
    if (!pendingTransferId) {
      await client.query('ROLLBACK')
      return res.status(500).json({ error: 'Could not create pending transfer state' })
    }
    await logSecurityEvent(client, {
      actor: targetDeviceId,
      eventType: 'Transfer confirmation',
      status: 'pending',
      detail: `Pending source approval ${codeRow.source_device_id} -> ${targetDeviceId}`,
      metadata: {
        code,
        source_device_id: codeRow.source_device_id,
        target_device_id: targetDeviceId,
        pending_transfer_id: pendingTransferId,
      },
    })
    await client.query('COMMIT')
    emitTransferScoped('transfer_confirmation_required', {
      code,
      pending_transfer_id: pendingTransferId,
      source_device_id: codeRow.source_device_id,
      target_device_id: targetDeviceId,
    })
    emitTransferScoped('transfer_pending', {
      code,
      pending_transfer_id: pendingTransferId,
      source_device_id: codeRow.source_device_id,
      target_device_id: targetDeviceId,
    })
    return res.json({
      ok: true,
      pending: true,
      pending_transfer_id: pendingTransferId,
      source_device_id: codeRow.source_device_id,
      target_device_id: targetDeviceId,
    })
  } catch (e) {
    await client.query('ROLLBACK')
    console.error('[transfer/confirm]', e)
    return res.status(500).json({ error: String(e.message || e) })
  } finally {
    client.release()
  }
})

deviceSecurityRouter.post('/transfer/decision', async (req, res) => {
  const pool = getPool()
  if (!pool) return res.status(503).json({ error: 'Database not configured' })
  await ensureSecurityTables(pool)
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  const pendingTransferId = text(b.pending_transfer_id ?? b.transfer_id, 64)
  const sourceDeviceId = text(b.source_device_id ?? b.device_id, 128)
  const actionRaw = text(b.action, 32).toLowerCase()
  const action = actionRaw === 'approve' || b.approve === true ? 'approve' : actionRaw === 'reject' ? 'reject' : ''
  if (!pendingTransferId || !sourceDeviceId || !action) {
    return res.status(400).json({ error: 'pending_transfer_id, source_device_id and action=approve|reject are required' })
  }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const transferRes = await client.query(
      `SELECT * FROM device_transfers WHERE id = $1 FOR UPDATE`,
      [pendingTransferId],
    )
    const transfer = transferRes.rows[0]
    if (!transfer) {
      await client.query('ROLLBACK')
      return res.status(404).json({ error: 'Pending transfer not found' })
    }
    if (String(transfer.source_device_id) !== sourceDeviceId) {
      await client.query('ROLLBACK')
      return res.status(403).json({ error: 'Only source device can decide this transfer' })
    }
    if (String(transfer.status) !== 'pending_confirmation') {
      await client.query('ROLLBACK')
      return res.status(400).json({ error: 'Transfer is not awaiting source approval' })
    }

    const code = String(transfer.code || '')
    if (action === 'reject') {
      await client.query(
        `UPDATE device_transfers
         SET status = 'rejected', reason = 'rejected_by_source', completed_at = now()
         WHERE id = $1`,
        [pendingTransferId],
      )
      if (transfer.code_id) {
        await client.query(
          `UPDATE transfer_codes
           SET status = 'revoked', revoked_at = now(), updated_at = now()
           WHERE id = $1`,
          [transfer.code_id],
        )
      }
      await logSecurityEvent(client, {
        actor: sourceDeviceId,
        eventType: 'Transfer confirmation',
        status: 'completed',
        detail: `Rejected transfer to ${transfer.target_device_id}`,
        metadata: {
          code,
          pending_transfer_id: pendingTransferId,
          source_device_id: sourceDeviceId,
          target_device_id: transfer.target_device_id,
        },
      })
      await client.query('COMMIT')
      emitTransferScoped('transfer_rejected', {
        code,
        reason: 'rejected_by_source',
        pending_transfer_id: pendingTransferId,
        source_device_id: sourceDeviceId,
        target_device_id: transfer.target_device_id,
      })
      return res.json({ ok: true, rejected: true, pending_transfer_id: pendingTransferId })
    }

    const sourceSubRes = await client.query(
      `SELECT * FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`,
      [sourceDeviceId],
    )
    const sourceSub = sourceSubRes.rows[0]
    if (!sourceSub) {
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

    await client.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash)
       VALUES ($1, 'active', $2, now(), $3, now(), $4)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         fingerprint_hash = COALESCE(EXCLUDED.fingerprint_hash, device_subscriptions.fingerprint_hash)`,
      [
        String(transfer.target_device_id),
        sourceSub.expires_at,
        `transfer:${code || pendingTransferId}`,
        transfer.target_fingerprint_hash || null,
      ],
    )
    await client.query(
      `UPDATE device_subscriptions SET status = 'pending', updated_at = now() WHERE device_id = $1`,
      [sourceDeviceId],
    )
    if (transfer.code_id) {
      await client.query(
        `UPDATE transfer_codes
         SET status = 'used', used_at = COALESCE(used_at, now()), updated_at = now()
         WHERE id = $1`,
        [transfer.code_id],
      )
    }
    await client.query(
      `UPDATE device_transfers
       SET status = 'approved', reason = 'approved_by_source'
       WHERE id = $1`,
      [pendingTransferId],
    )
    await client.query(
      `UPDATE device_transfers
       SET status = 'completed', reason = 'approved_by_source', completed_at = now()
       WHERE id = $1`,
      [pendingTransferId],
    )
    await logSecurityEvent(client, {
      actor: sourceDeviceId,
      eventType: 'Transfer confirmation',
      status: 'completed',
      detail: `Approved transfer to ${transfer.target_device_id}`,
      metadata: {
        code,
        pending_transfer_id: pendingTransferId,
        source_device_id: sourceDeviceId,
        target_device_id: transfer.target_device_id,
      },
    })
    await client.query('COMMIT')
    deviceSubscriptionBus.emit('update', { deviceId: sourceDeviceId })
    deviceSubscriptionBus.emit('update', { deviceId: String(transfer.target_device_id) })
    emitTransferScoped('transfer_completed', {
      code,
      pending_transfer_id: pendingTransferId,
      source_device_id: sourceDeviceId,
      target_device_id: transfer.target_device_id,
    })
    emitTransferScoped('subscription_revoked', {
      device_id: sourceDeviceId,
      pending_transfer_id: pendingTransferId,
      source_device_id: sourceDeviceId,
      target_device_id: transfer.target_device_id,
      reason: 'transferred',
    })
    return res.json({
      ok: true,
      approved: true,
      pending_transfer_id: pendingTransferId,
      source_device_id: sourceDeviceId,
      target_device_id: transfer.target_device_id,
    })
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[transfer/decision]', e)
    return res.status(500).json({ error: String(e.message || e) })
  } finally {
    client.release()
  }
})

deviceSecurityRouter.post('/transfer/admin-force', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const sourceDeviceId = text(b.source_device_id, 128)
    const targetDeviceId = text(b.target_device_id, 128)
    const targetFpHash = fingerprintHash(b.target_fingerprint || b.fingerprint)
    const result = await executeAdminForceTransfer(pool, {
      sourceDeviceId,
      targetDeviceId,
      targetFpHash,
      auditExtra: '',
    })
    if (!result.ok) return res.status(result.status).json({ error: result.error })
    return res.json({ ok: true, source_device_id: result.source_device_id, target_device_id: result.target_device_id })
  } catch (e) {
    console.error('[transfer/admin-force]', e)
    return res.status(500).json({ error: String(e.message || e) })
  }
})

deviceSecurityRouter.post('/transfer/admin-force-phone', async (req, res) => {
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
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
      auditExtra,
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
  try {
    const pool = getPool()
    if (!pool) return res.status(503).json({ error: 'Database not configured' })
    await ensureSecurityTables(pool)
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = text(b.device_id, 128)
    const fpHash = fingerprintHash(b.fingerprint)
    if (!deviceId || !fpHash) return res.status(400).json({ error: 'device_id and fingerprint are required' })
    const { rows } = await pool.query(
      `SELECT device_id, expires_at, status
       FROM device_subscriptions
       WHERE fingerprint_hash = $1
       ORDER BY updated_at DESC
       LIMIT 1`,
      [fpHash],
    )
    const row = rows[0]
    if (!row) return res.status(404).json({ ok: false, error: 'No recoverable subscription' })
    const validity = await pool.query(`SELECT ($1::timestamptz > now()) AS valid`, [row.expires_at])
    if (!validity.rows[0]?.valid) return res.status(400).json({ ok: false, error: 'Recovered subscription expired' })
    await pool.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash)
       VALUES ($1, 'active', $2, now(), $3, now(), $4)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         fingerprint_hash = EXCLUDED.fingerprint_hash`,
      [deviceId, row.expires_at, `recovery:${row.device_id}`, fpHash],
    )
    emitSync('transfer_completed', { source_device_id: row.device_id, target_device_id: deviceId, reason: 'recovery' })
    deviceSubscriptionBus.emit('update', { deviceId })
    return res.json({ ok: true, recovered_from: row.device_id })
  } catch (e) {
    console.error('[subscription/recover]', e)
    return res.status(500).json({ error: String(e.message || e) })
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
    await pool.query(
      `UPDATE device_subscriptions
       SET status = 'pending', updated_at = now()
       WHERE device_id = $1`,
      [deviceId],
    )
    await logSecurityEvent(pool, {
      actor: 'Admin',
      eventType: 'Subscription revoked',
      status: 'completed',
      detail: `Revoked subscription for ${deviceId}`,
      metadata: { device_id: deviceId },
    })
    deviceSubscriptionBus.emit('update', { deviceId })
    emitSync('subscription_revoked', { device_id: deviceId })
    return res.json({ ok: true, device_id: deviceId })
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
