import fs from 'node:fs/promises'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from './liveSyncBus.js'
import { UPLOADS_DIR, ensureUploadsDir } from '../multerUpload.js'
import { isOneSignalConfigured, sendOneSignalNotification } from './oneSignalPush.js'

const DEFAULT_PUBLIC_BASE = 'https://osmani-admin-api.onrender.com'

function resolvePublicBaseUrl() {
  return String(process.env.BASE_URL ?? '').trim().replace(/\/$/, '') || DEFAULT_PUBLIC_BASE
}

/** Public HTTPS URL for a stored `/uploads/...` path (OneSignal requires HTTPS for images). */
export function absoluteUrlForStoredPath(relativePath) {
  const rel = String(relativePath ?? '').trim()
  if (!rel) return ''
  if (rel.startsWith('http://') || rel.startsWith('https://')) return rel
  const base = resolvePublicBaseUrl()
  if (rel.startsWith('/')) return `${base}${rel}`
  return `${base}/${rel.replace(/^\/+/, '')}`
}

/**
 * Writes data-URL images to disk; returns `/uploads/...` or original if already a URL/path.
 */
export async function persistNotificationDataUrlImageIfNeeded(imageField) {
  const raw = String(imageField ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/uploads/')) return raw
  const compact = raw.replace(/\s/g, '')
  const m = /^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/i.exec(compact)
  if (!m) return raw.startsWith('data:') ? '' : raw
  const ext = m[1].toLowerCase() === 'jpeg' ? 'jpg' : m[1].toLowerCase()
  let buf
  try {
    buf = Buffer.from(m[2], 'base64')
  } catch {
    return ''
  }
  if (!buf.length || buf.length > 5 * 1024 * 1024) {
    throw new Error('Notification image is invalid or exceeds 5 MB')
  }
  ensureUploadsDir()
  const name = `notif-${Date.now()}-${randomBytes(6).toString('hex')}.${ext}`
  const full = path.join(UPLOADS_DIR, name)
  await fs.writeFile(full, buf)
  return `/uploads/${name}`
}

const ADMIN_NOTIFICATION_STATUSES = new Set(['draft', 'scheduled', 'sent', 'cancelled', 'archived'])
const DELIVERY_STATES = new Set(['pending', 'sent', 'partial', 'failed'])
const NOTIFICATION_KINDS = new Set(['admin', 'system'])
const NOTIFICATION_SEVERITIES = new Set(['info', 'success', 'warning', 'critical'])
const PUBLIC_AUDIENCES = new Set(['all', 'premium', 'trial', 'inactive'])

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

function text(value, max = 4000) {
  return String(value ?? '')
    .trim()
    .slice(0, max)
}

function asIsoOrNull(value) {
  if (value == null || value === '') return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toISOString()
}

function asNotificationStatus(value, fallback = 'draft') {
  const normalized = text(value, 32).toLowerCase()
  return ADMIN_NOTIFICATION_STATUSES.has(normalized) ? normalized : fallback
}

function asDeliveryState(value, fallback = 'pending') {
  const normalized = text(value, 32).toLowerCase()
  return DELIVERY_STATES.has(normalized) ? normalized : fallback
}

function asNotificationKind(value, fallback = 'admin') {
  const normalized = text(value, 32).toLowerCase()
  return NOTIFICATION_KINDS.has(normalized) ? normalized : fallback
}

function asSeverity(value, fallback = 'info') {
  const normalized = text(value, 32).toLowerCase()
  return NOTIFICATION_SEVERITIES.has(normalized) ? normalized : fallback
}

function asAudience(value, fallback = 'all') {
  const normalized = text(value, 32).toLowerCase()
  return PUBLIC_AUDIENCES.has(normalized) ? normalized : fallback
}

function sanitizeImage(value) {
  const raw = text(value, 600_000)
  if (!raw) return ''
  if (raw.startsWith('data:image/')) return raw
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/uploads/')) return raw
  return ''
}

function sanitizePayload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return value
}

function shouldBeActive(status, explicit) {
  if (typeof explicit === 'boolean') return explicit
  return status !== 'cancelled' && status !== 'archived'
}

function toApiNotification(row) {
  if (!row) return null
  const p = sanitizePayload(row.payload)
  return {
    id: String(row.id),
    kind: text(row.kind, 32) || 'admin',
    title: text(row.title, 200),
    message: text(row.message, 4000),
    image: text(row.image, 600_000),
    targetAudience: text(row.target_audience, 32) || 'all',
    targetType: text(row.target_type, 512) || 'osmani://home',
    status: text(row.status, 32) || 'draft',
    deliveryState: text(row.delivery_state, 32) || 'pending',
    severity: text(row.severity, 32) || 'info',
    sourceEvent: text(row.source_event, 128),
    clicks: Number(row.clicks) || 0,
    isActive: row.is_active === true,
    scheduleAt: row.schedule_at ? new Date(row.schedule_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    createdBy: text(row.created_by, 120) || 'system',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    payload: p,
    onesignalId: p.onesignal_id != null ? String(p.onesignal_id) : null,
    onesignalRecipients: Number(p.onesignal_recipients) || null,
    deliveryError: p.onesignal_error != null ? String(p.onesignal_error).slice(0, 500) : null,
  }
}

function publishNotificationsChanged(meta = {}) {
  liveSyncBus.publish('config.notifications_changed', {
    topics: ['config'],
    action: text(meta.action, 32) || 'updated',
    synced_at: new Date().toISOString(),
    ...(meta.notificationId ? { notificationId: String(meta.notificationId) } : {}),
    ...(meta.sourceEvent ? { sourceEvent: text(meta.sourceEvent, 128) } : {}),
  })
}

export async function flushDueNotifications() {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT * FROM notifications
     WHERE kind = 'admin'
       AND status = 'scheduled'
       AND is_active = true
       AND schedule_at IS NOT NULL
       AND schedule_at <= now()
     ORDER BY schedule_at ASC
     LIMIT 25`,
  )
  for (const row of rows) {
    const id = String(row.id)
    let imagePath = String(row.image ?? '').trim()
    try {
      if (!isOneSignalConfigured()) {
        const failPayload = {
          ...sanitizePayload(row.payload),
          onesignal_error: 'OneSignal not configured at send time',
        }
        await pool.query(
          `UPDATE notifications
           SET delivery_state = 'failed', updated_at = now(), payload = $2::jsonb
           WHERE id = $1`,
          [id, JSON.stringify(failPayload)],
        )
        continue
      }
      if (imagePath.startsWith('data:image')) {
        imagePath = await persistNotificationDataUrlImageIfNeeded(imagePath)
        await pool.query(`UPDATE notifications SET image = $2 WHERE id = $1`, [id, imagePath])
      }
      const result = await sendOneSignalNotification(
        { title: row.title, message: row.message },
        { source: 'notifications.flushDueNotifications', notificationId: id },
      )
      const newPayload = {
        ...sanitizePayload(row.payload),
        onesignal_id: result.id,
        onesignal_recipients: result.recipients,
      }
      await pool.query(
        `UPDATE notifications
         SET status = 'sent',
             delivery_state = 'sent',
             sent_at = COALESCE(sent_at, now()),
             updated_at = now(),
             payload = $2::jsonb
         WHERE id = $1`,
        [id, JSON.stringify(newPayload)],
      )
    } catch (e) {
      const failPayload = {
        ...sanitizePayload(row.payload),
        onesignal_error: String(e.message || e).slice(0, 2000),
      }
      await pool.query(
        `UPDATE notifications
         SET delivery_state = 'failed', updated_at = now(), payload = $2::jsonb
         WHERE id = $1`,
        [id, JSON.stringify(failPayload)],
      )
    }
  }
  if (rows.length > 0) {
    publishNotificationsChanged({ action: 'released' })
  }
  return rows.length
}

function normalizeAdminNotificationInput(body, existing = null) {
  const payload = body && typeof body === 'object' ? body : {}
  const status =
    payload.status === 'sent' || payload.status === 'scheduled' || payload.status === 'cancelled'
      ? asNotificationStatus(payload.status, 'draft')
      : existing?.status || 'draft'
  const scheduleAt = asIsoOrNull(payload.scheduleAt ?? payload.schedule_at ?? existing?.schedule_at)
  const sentAt =
    status === 'sent'
      ? asIsoOrNull(payload.sentAt ?? payload.sent_at ?? existing?.sent_at) || new Date().toISOString()
      : null
  return {
    kind: asNotificationKind(payload.kind ?? existing?.kind, 'admin'),
    title: text(payload.title ?? existing?.title, 200),
    message: text(payload.message ?? existing?.message, 4000),
    image: sanitizeImage(payload.image ?? existing?.image),
    targetAudience: 'all',
    targetType: text(payload.targetType ?? payload.target_type ?? existing?.target_type, 512) || 'osmani://home',
    status,
    deliveryState: asDeliveryState(
      payload.deliveryState ?? payload.delivery_state ?? existing?.delivery_state,
      status === 'sent' ? 'sent' : 'pending',
    ),
    severity: asSeverity(payload.severity ?? existing?.severity, 'info'),
    sourceEvent: text(payload.sourceEvent ?? payload.source_event ?? existing?.source_event, 128),
    payload: sanitizePayload(payload.payload ?? existing?.payload),
    clicks: Math.max(0, Number(payload.clicks ?? existing?.clicks) || 0),
    isActive: shouldBeActive(status, payload.isActive ?? payload.is_active ?? existing?.is_active),
    scheduleAt,
    sentAt,
    expiresAt: asIsoOrNull(payload.expiresAt ?? payload.expires_at ?? existing?.expires_at),
    createdBy: text(payload.createdBy ?? payload.created_by ?? existing?.created_by, 120) || 'Admin',
  }
}

export async function listNotificationsAdmin() {
  await flushDueNotifications()
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT *
     FROM notifications
     ORDER BY COALESCE(sent_at, schedule_at, created_at) DESC, created_at DESC`
  )
  return rows.map(toApiNotification)
}

export async function listRuntimeNotifications({ audience = 'all' } = {}) {
  await flushDueNotifications()
  const pool = requirePool()
  const normalizedAudience = asAudience(audience, 'all')
  const { rows } = await pool.query(
    `SELECT *
     FROM notifications
     WHERE is_active = true
       AND status = 'sent'
       AND (expires_at IS NULL OR expires_at > now())
       AND (target_audience = 'all' OR target_audience = $1)
     ORDER BY COALESCE(sent_at, created_at) DESC, created_at DESC
     LIMIT 50`,
    [normalizedAudience],
  )
  return rows.map(toApiNotification)
}

export async function createAdminNotification(body, actor = 'Admin') {
  const next = normalizeAdminNotificationInput(body, null)
  if (!next.title) throw new Error('title is required')
  if (!next.message) throw new Error('message is required')
  const pool = requirePool()

  let imageForDb = next.image
  let mergedPayload = { ...next.payload }
  let deliveryState = next.deliveryState

  if (next.kind === 'admin' && next.image && String(next.image).startsWith('data:image')) {
    imageForDb = await persistNotificationDataUrlImageIfNeeded(next.image)
  }

  if (next.kind === 'admin' && next.status === 'sent') {
    if (!isOneSignalConfigured()) {
      throw new Error(
        'OneSignal is not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY on the server, then retry.',
      )
    }
    const result = await sendOneSignalNotification(
      { title: next.title, message: next.message },
      { source: 'notifications.createAdminNotification' },
    )
    mergedPayload = {
      ...mergedPayload,
      onesignal_id: result.id,
      onesignal_recipients: result.recipients,
    }
    deliveryState = 'sent'
  }

  const { rows } = await pool.query(
    `INSERT INTO notifications (
       kind, title, message, image, target_audience, target_type, status, delivery_state,
       severity, source_event, payload, clicks, is_active, schedule_at, sent_at, expires_at,
       created_by, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::jsonb, $12, $13, $14::timestamptz, $15::timestamptz, $16::timestamptz,
       $17, now()
     )
     RETURNING *`,
    [
      next.kind,
      next.title,
      next.message,
      imageForDb,
      next.targetAudience,
      next.targetType,
      next.status,
      deliveryState,
      next.severity,
      next.sourceEvent,
      mergedPayload,
      next.clicks,
      next.isActive,
      next.scheduleAt,
      next.sentAt,
      next.expiresAt,
      text(actor, 120) || next.createdBy,
    ],
  )
  publishNotificationsChanged({ action: 'created', notificationId: rows[0]?.id })
  return toApiNotification(rows[0])
}

export async function updateNotificationById(id, body, actor = 'Admin') {
  const pool = requirePool()
  const existingRes = await pool.query(`SELECT * FROM notifications WHERE id = $1`, [String(id)])
  const existing = existingRes.rows[0]
  if (!existing) return null
  const next = normalizeAdminNotificationInput(body, existing)
  if (!next.title) throw new Error('title is required')
  if (!next.message) throw new Error('message is required')
  const { rows } = await pool.query(
    `UPDATE notifications
     SET kind = $2,
         title = $3,
         message = $4,
         image = $5,
         target_audience = $6,
         target_type = $7,
         status = $8,
         delivery_state = $9,
         severity = $10,
         source_event = $11,
         payload = $12::jsonb,
         clicks = $13,
         is_active = $14,
         schedule_at = $15::timestamptz,
         sent_at = $16::timestamptz,
         expires_at = $17::timestamptz,
         created_by = $18,
         updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [
      String(id),
      next.kind,
      next.title,
      next.message,
      next.image,
      next.targetAudience,
      next.targetType,
      next.status,
      next.deliveryState,
      next.severity,
      next.sourceEvent,
      next.payload,
      next.clicks,
      next.isActive,
      next.scheduleAt,
      next.sentAt,
      next.expiresAt,
      text(actor, 120) || next.createdBy,
    ],
  )
  publishNotificationsChanged({ action: 'updated', notificationId: rows[0]?.id })
  return toApiNotification(rows[0])
}

export async function deleteNotificationById(id) {
  const pool = requirePool()
  const { rows } = await pool.query(`DELETE FROM notifications WHERE id = $1 RETURNING id`, [String(id)])
  if (rows.length > 0) {
    publishNotificationsChanged({ action: 'deleted', notificationId: rows[0].id })
    return true
  }
  return false
}

/** Deletes all admin campaign rows (system-generated rows are kept). */
export async function deleteAllNotificationsAdmin() {
  const pool = requirePool()
  const { rowCount } = await pool.query(`DELETE FROM notifications WHERE kind = 'admin'`)
  const n = Number(rowCount) || 0
  if (n > 0) {
    publishNotificationsChanged({ action: 'bulk_deleted' })
  }
  return n
}

function buildSystemNotificationFromEvent(event, payload = {}) {
  const sourceEvent = text(event, 128)
  const body = payload && typeof payload === 'object' ? payload : {}
  if (sourceEvent === 'config.settings_changed') {
    const modes = body.modes && typeof body.modes === 'object' ? body.modes : {}
    if (modes.emergency_mode === true) {
      return {
        title: 'Emergency mode enabled',
        message: 'Runtime clients should suspend playback and surface emergency messaging immediately.',
        severity: 'critical',
      }
    }
    if (modes.maintenance_mode === true) {
      return {
        title: 'Maintenance mode enabled',
        message: 'Runtime clients should surface maintenance messaging while backend gating stays active.',
        severity: 'warning',
      }
    }
    if (modes.free_mode === true) {
      return {
        title: 'Free mode enabled',
        message: 'Runtime clients can surface the current free-access announcement immediately.',
        severity: 'success',
      }
    }
    return {
      title: 'Runtime modes updated',
      message: 'The backend runtime mode state changed and connected clients should refresh messaging.',
      severity: 'info',
    }
  }
  if (sourceEvent === 'config.app_update_changed') {
    const decision = text(body.updateDecision, 32).toUpperCase() || 'NONE'
    return {
      title: decision === 'FORCE' ? 'Force update published' : decision === 'SOFT' ? 'App update published' : 'App update cleared',
      message:
        decision === 'FORCE'
          ? 'Runtime clients should surface a blocking update prompt.'
          : decision === 'SOFT'
            ? 'Runtime clients should surface a non-blocking app update prompt.'
            : 'Runtime clients should clear any previous app update message.',
      severity: decision === 'FORCE' ? 'critical' : decision === 'SOFT' ? 'warning' : 'info',
    }
  }
  if (sourceEvent === 'popup_settings_changed') {
    const mode = text(body.mode, 32) || 'show_once'
    return {
      title: 'Popup announcement updated',
      message: `Runtime popup content changed and should refresh immediately (mode: ${mode}).`,
      severity: mode === 'disabled' ? 'info' : 'warning',
    }
  }
  if (sourceEvent === 'transfer_requested') {
    return {
      title: 'Transfer requested',
      message: 'A device transfer request was created and active sessions should refresh transfer state.',
      severity: 'warning',
    }
  }
  if (sourceEvent === 'transfer_completed') {
    return {
      title: 'Transfer completed',
      message: 'A device transfer completed and affected sessions should refresh runtime access state.',
      severity: 'success',
    }
  }
  if (sourceEvent === 'transfer_rejected') {
    return {
      title: 'Transfer rejected',
      message: 'A device transfer was rejected and active sessions should refresh transfer state.',
      severity: 'warning',
    }
  }
  if (sourceEvent === 'subscription_revoked') {
    return {
      title: 'Runtime subscription revoked',
      message: 'A device subscription was revoked and affected sessions should refresh immediately.',
      severity: 'critical',
    }
  }
  if (sourceEvent === 'subscription_manual_grant') {
    return {
      title: 'Manual subscription granted',
      message: 'A manual subscription grant was issued and the affected runtime session should refresh immediately.',
      severity: 'success',
    }
  }
  if (sourceEvent === 'subscription_offer_code_redeemed') {
    return {
      title: 'Offer code redeemed',
      message: 'An offer-code subscription grant was applied and the affected runtime session should refresh immediately.',
      severity: 'success',
    }
  }
  return null
}

export async function recordSystemNotificationEvent(event, payload = {}) {
  const built = buildSystemNotificationFromEvent(event, payload)
  if (!built) return null
  const pool = requirePool()
  const { rows: recentRows } = await pool.query(
    `SELECT id
     FROM notifications
     WHERE kind = 'system'
       AND source_event = $1
       AND title = $2
       AND message = $3
       AND created_at >= now() - interval '30 seconds'
     ORDER BY created_at DESC
     LIMIT 1`,
    [text(event, 128), built.title, built.message],
  )
  if (recentRows.length > 0) return null
  const { rows } = await pool.query(
    `INSERT INTO notifications (
       kind, title, message, image, target_audience, target_type, status, delivery_state,
       severity, source_event, payload, clicks, is_active, schedule_at, sent_at, expires_at,
       created_by, updated_at
     ) VALUES (
       'system', $1, $2, '', 'all', 'osmani://home', 'sent', 'sent',
       $3, $4, $5::jsonb, 0, true, NULL, now(), NULL,
       'system', now()
     )
     RETURNING *`,
    [built.title, built.message, built.severity, text(event, 128), sanitizePayload(payload)],
  )
  publishNotificationsChanged({
    action: 'created',
    notificationId: rows[0]?.id,
    sourceEvent: text(event, 128),
  })
  return toApiNotification(rows[0])
}
