import { getPool } from '../db/pool.js'
import { liveSyncBus } from './liveSyncBus.js'
import { isOneSignalConfigured, sendOneSignalNotification } from './oneSignalPush.js'
import { resolvePublicAssetUrl } from './cdnAssets.js'
import {
  isNotificationImageUploadPath,
  resolveNotificationImagePublicUrl,
} from './notificationImageStorage.js'
import {
  fetchOneSignalMessageStats,
  normalizeOneSignalStatsPayload,
} from './oneSignalStats.js'
import {
  parseNotificationImageDataUrl,
  persistOptimizedNotificationImage,
} from './notificationImageOptimize.js'
import {
  buildNotificationDestination,
  destinationFromPayloadAndTargetType,
  mergeDestinationIntoPayload,
  oneSignalDataFromDestination,
} from './notificationDestination.js'
import {
  computeNextScheduleAt,
  isRecurringKind,
  normalizeRecurrenceFields,
  recurrenceAdvanceFrom,
  recurrenceKindLabel,
} from './notificationRecurrence.js'
const ONESIGNAL_STATS_STALE_MS = Math.max(
  15_000,
  Number(process.env.ONESIGNAL_STATS_STALE_MS) || 45_000,
)
const ONESIGNAL_STATS_SYNC_LIMIT = Math.min(
  25,
  Math.max(1, Number(process.env.ONESIGNAL_STATS_SYNC_LIMIT) || 12),
)

/** Public HTTPS URL for a stored `/uploads/...` path (OneSignal requires HTTPS for images). */
export function absoluteUrlForStoredPath(relativePath, req = null) {
  const stored = String(relativePath ?? '').trim()
  if (isNotificationImageUploadPath(stored)) {
    return resolveNotificationImagePublicUrl(stored)
  }
  const resolved = resolvePublicAssetUrl(relativePath, req)
  return resolved != null ? String(resolved) : ''
}

/** Public HTTPS URL suitable for OneSignal rich push (big_picture / ios_attachments). */
export function resolveOneSignalPushImageUrl(imageField) {
  const stored = String(imageField ?? '').trim()
  if (!stored) return ''
  const absolute = absoluteUrlForStoredPath(stored)
  if (absolute.startsWith('https://')) return absolute
  return ''
}

/**
 * Persist data-URL uploads to /uploads and return { imageForDb, pushImageUrl }.
 */
export async function prepareNotificationImageForPush(imageField) {
  try {
    let imageForDb = sanitizeImage(imageField)
    if (!imageForDb) return { imageForDb: '', pushImageUrl: '' }
    if (imageForDb.startsWith('data:image')) {
      imageForDb = await persistNotificationDataUrlImageIfNeeded(imageForDb)
    }
    const pushImageUrl = resolveOneSignalPushImageUrl(imageForDb)
    return { imageForDb, pushImageUrl }
  } catch (e) {
    console.error('[notifications] prepareNotificationImageForPush failed (text-only send):', e)
    const fallbackDb = sanitizeImage(imageField)
    return { imageForDb: fallbackDb.startsWith('data:') ? '' : fallbackDb, pushImageUrl: '' }
  }
}

/**
 * Writes data-URL images to disk; returns `/uploads/...` or original if already a URL/path.
 */
export async function persistNotificationDataUrlImageIfNeeded(imageField) {
  const raw = String(imageField ?? '').trim()
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('/uploads/')) return raw
  const parsed = parseNotificationImageDataUrl(raw)
  if (!parsed) return raw.startsWith('data:') ? '' : raw
  const { imageForDb } = await persistOptimizedNotificationImage(parsed.buf, { mime: parsed.mime })
  return imageForDb
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

function resolveNotificationImageForApi(imageField, req) {
  const raw = text(imageField, 600_000)
  if (!raw) return ''
  if (raw.startsWith('data:')) return raw
  if (isNotificationImageUploadPath(raw)) {
    return resolveNotificationImagePublicUrl(raw) || raw
  }
  return resolvePublicAssetUrl(raw, req) || raw
}

function toApiNotification(row, req = null) {
  if (!row) return null
  const p = sanitizePayload(row.payload)
  const targetType = text(row.target_type, 512) || 'osmani://home'
  const destination = destinationFromPayloadAndTargetType(p, targetType)
  const recurrenceKind = text(row.recurrence_kind, 32) || 'once'
  return {
    id: String(row.id),
    kind: text(row.kind, 32) || 'admin',
    title: text(row.title, 200),
    message: text(row.message, 4000),
    image: resolveNotificationImageForApi(row.image, req),
    targetAudience: text(row.target_audience, 32) || 'all',
    targetType,
    destination,
    status: text(row.status, 32) || 'draft',
    deliveryState: text(row.delivery_state, 32) || 'pending',
    severity: text(row.severity, 32) || 'info',
    sourceEvent: text(row.source_event, 128),
    clicks: Number(row.clicks) || 0,
    isActive: row.is_active === true,
    scheduleAt: row.schedule_at ? new Date(row.schedule_at).toISOString() : null,
    sentAt: row.sent_at ? new Date(row.sent_at).toISOString() : null,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    recurrenceKind,
    recurrenceInterval:
      row.recurrence_interval != null && row.recurrence_interval !== ''
        ? Number(row.recurrence_interval)
        : null,
    recurrenceUntil: row.recurrence_until ? new Date(row.recurrence_until).toISOString() : null,
    recurrenceAnchorAt: row.recurrence_anchor_at
      ? new Date(row.recurrence_anchor_at).toISOString()
      : null,
    recurrenceParentId: row.recurrence_parent_id != null ? String(row.recurrence_parent_id) : null,
    isRecurrenceTemplate: row.is_recurrence_template === true,
    recurrenceLabel: recurrenceKindLabel(recurrenceKind, row.recurrence_interval),
    createdBy: text(row.created_by, 120) || 'system',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    payload: p,
    onesignalId: p.onesignal_id != null ? String(p.onesignal_id) : null,
    onesignalRecipients: Number(p.onesignal_recipients) || null,
    onesignalDelivered:
      p.onesignal_delivered != null && p.onesignal_delivered !== '' ? Number(p.onesignal_delivered) : null,
    onesignalConfirmed:
      p.onesignal_confirmed != null && p.onesignal_confirmed !== ''
        ? Number(p.onesignal_confirmed)
        : null,
    onesignalFailed:
      p.onesignal_failed != null && p.onesignal_failed !== '' ? Number(p.onesignal_failed) : null,
    onesignalErrored:
      p.onesignal_errored != null && p.onesignal_errored !== '' ? Number(p.onesignal_errored) : null,
    onesignalClicked:
      p.onesignal_clicked != null && p.onesignal_clicked !== '' ? Number(p.onesignal_clicked) : null,
    onesignalCtr:
      p.onesignal_ctr != null && p.onesignal_ctr !== '' ? Number(p.onesignal_ctr) : null,
    onesignalSentAt: p.onesignal_sent_at != null ? String(p.onesignal_sent_at) : null,
    onesignalStatsSyncedAt:
      p.onesignal_stats_synced_at != null ? String(p.onesignal_stats_synced_at) : null,
    deliveryError: p.onesignal_error != null ? String(p.onesignal_error).slice(0, 500) : null,
    onesignalStatsError:
      p.onesignal_stats_error != null ? String(p.onesignal_stats_error).slice(0, 500) : null,
  }
}

/**
 * Pull delivery/click stats from OneSignal and merge into notification payload.
 */
export async function syncOneSignalStatsForRow(row) {
  if (!row || !isOneSignalConfigured()) return null
  const pool = requirePool()
  const id = String(row.id)
  const basePayload = sanitizePayload(row.payload)
  const messageId = basePayload.onesignal_id != null ? String(basePayload.onesignal_id).trim() : ''
  if (!messageId) return null

  try {
    const raw = await fetchOneSignalMessageStats(messageId)
    const statsPatch = normalizeOneSignalStatsPayload(raw, basePayload)
    const { onesignal_stats_error: _prevStatsErr, ...payloadWithoutStatsErr } = basePayload
    const merged = {
      ...payloadWithoutStatsErr,
      ...statsPatch,
      onesignal_recipients:
        basePayload.onesignal_recipients ??
        (Number(raw?.successful) > 0 ? Number(raw.successful) : basePayload.onesignal_recipients),
    }
    const sentAtFromOs = statsPatch.onesignal_sent_at
    await pool.query(
      `UPDATE notifications
       SET payload = $2::jsonb,
           sent_at = COALESCE(sent_at, $3::timestamptz),
           updated_at = now()
       WHERE id = $1`,
      [id, JSON.stringify(merged), sentAtFromOs],
    )
    publishNotificationsChanged({ action: 'stats_synced', notificationId: id })
    return merged
  } catch (e) {
    const merged = {
      ...basePayload,
      onesignal_stats_synced_at: new Date().toISOString(),
      onesignal_stats_error: String(e.message || e).slice(0, 500),
    }
    await pool.query(
      `UPDATE notifications SET payload = $2::jsonb, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(merged)],
    )
    return null
  }
}

export async function syncOneSignalStatsById(notificationId) {
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT * FROM notifications WHERE id = $1 LIMIT 1`, [
    String(notificationId),
  ])
  if (!rows[0]) return null
  return syncOneSignalStatsForRow(rows[0])
}

/** Manual admin refresh: sync OneSignal stats for one row and return API shape. */
export async function refreshNotificationStatsAdmin(notificationId, req = null) {
  const pool = requirePool()
  const id = String(notificationId)
  const { rows } = await pool.query(`SELECT * FROM notifications WHERE id = $1 LIMIT 1`, [id])
  if (!rows[0]) return null
  await syncOneSignalStatsForRow(rows[0])
  const { rows: updated } = await pool.query(`SELECT * FROM notifications WHERE id = $1 LIMIT 1`, [id])
  return updated[0] ? toApiNotification(updated[0], req) : null
}

/** Refresh stats for recently sent pushes (stale or never synced). */
export async function syncStaleOneSignalStats({ limit = ONESIGNAL_STATS_SYNC_LIMIT } = {}) {
  if (!isOneSignalConfigured()) return 0
  const pool = requirePool()
  const max = Math.min(25, Math.max(1, Number(limit) || ONESIGNAL_STATS_SYNC_LIMIT))
  const staleSec = Math.ceil(ONESIGNAL_STATS_STALE_MS / 1000)
  const { rows } = await pool.query(
    `SELECT *
     FROM notifications
     WHERE status = 'sent'
       AND COALESCE(payload->>'onesignal_id', '') <> ''
       AND COALESCE(sent_at, created_at) > now() - interval '30 days'
       AND (
         payload->>'onesignal_stats_synced_at' IS NULL
         OR (payload->>'onesignal_stats_synced_at')::timestamptz < now() - ($1::int * interval '1 second')
       )
     ORDER BY COALESCE(sent_at, created_at) DESC
     LIMIT $2`,
    [staleSec, max],
  )
  let synced = 0
  for (const row of rows) {
    const out = await syncOneSignalStatsForRow(row)
    if (out) synced += 1
  }
  return synced
}

function scheduleOneSignalStatsRefresh(notificationId) {
  const id = String(notificationId)
  const run = () => {
    void syncOneSignalStatsById(id).catch((e) => {
      console.error('[notifications] OneSignal stats sync failed:', e)
    })
  }
  run()
  setTimeout(run, 8_000)
  setTimeout(run, 30_000)
  setTimeout(run, 120_000)
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

async function deliverAdminNotificationPush(row, pushImageUrl, logSource) {
  const basePayload = sanitizePayload(row.payload)
  const destination = destinationFromPayloadAndTargetType(basePayload, row.target_type)
  const pushData = oneSignalDataFromDestination(destination)
  const result = await sendOneSignalNotification(
    {
      title: row.title,
      message: row.message,
      imageUrl: pushImageUrl,
      data: pushData,
    },
    { source: logSource, notificationId: String(row.id) },
  )
  return {
    ...basePayload,
    onesignal_id: result.id,
    onesignal_recipients: result.recipients,
    onesignal_push_image_url: result.pushImageUrl,
    onesignal_image_skipped: result.imageSkipped || false,
    onesignal_image_skip_reason: result.imageSkipReason || null,
    onesignal_api_host: result.apiHost,
  }
}

async function insertSentNotificationInstance(pool, templateRow, sentPayload, sentAtIso) {
  const { rows } = await pool.query(
    `INSERT INTO notifications (
       kind, title, message, image, target_audience, target_type, status, delivery_state,
       severity, source_event, payload, clicks, is_active, schedule_at, sent_at, expires_at,
       recurrence_kind, recurrence_interval, recurrence_until, recurrence_anchor_at,
       recurrence_parent_id, is_recurrence_template, created_by, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, 'sent', 'sent',
       $7, $8, $9::jsonb, $10, true, NULL, $11::timestamptz, $12::timestamptz,
       'once', NULL, NULL, NULL, $13::uuid, false, $14, now()
     )
     RETURNING *`,
    [
      templateRow.kind,
      templateRow.title,
      templateRow.message,
      templateRow.image,
      templateRow.target_audience,
      templateRow.target_type,
      templateRow.severity,
      templateRow.source_event,
      JSON.stringify(sentPayload),
      Number(templateRow.clicks) || 0,
      sentAtIso,
      templateRow.expires_at,
      templateRow.id,
      templateRow.created_by,
    ],
  )
  return rows[0]
}

async function advanceRecurrenceTemplate(pool, templateRow, sentAtIso) {
  const kind = text(templateRow.recurrence_kind, 32) || 'once'
  const from = recurrenceAdvanceFrom({
    kind,
    scheduleAt: templateRow.schedule_at,
    sentAtIso,
  })
  const nextAt = computeNextScheduleAt({
    from,
    kind,
    interval: templateRow.recurrence_interval,
    anchorAt: templateRow.recurrence_anchor_at ?? templateRow.schedule_at,
  })
  const until = templateRow.recurrence_until ? new Date(templateRow.recurrence_until) : null
  const nextDate = nextAt ? new Date(nextAt) : null
  if (!nextAt || (until && nextDate && nextDate.getTime() > until.getTime())) {
    await pool.query(
      `UPDATE notifications
       SET status = 'cancelled', is_active = false, updated_at = now()
       WHERE id = $1`,
      [String(templateRow.id)],
    )
    return null
  }
  await pool.query(
    `UPDATE notifications
     SET schedule_at = $2::timestamptz, delivery_state = 'pending', updated_at = now()
     WHERE id = $1`,
    [String(templateRow.id), nextAt],
  )
  return nextAt
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
    const recurrenceKind = text(row.recurrence_kind, 32) || 'once'
    const isRecurringTemplate = row.is_recurrence_template === true || isRecurringKind(recurrenceKind)
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
      const { imageForDb, pushImageUrl } = await prepareNotificationImageForPush(imagePath)
      if (imageForDb && imageForDb !== imagePath) {
        imagePath = imageForDb
        await pool.query(`UPDATE notifications SET image = $2 WHERE id = $1`, [id, imagePath])
        row.image = imagePath
      }
      const sentPayload = await deliverAdminNotificationPush(
        row,
        pushImageUrl,
        isRecurringTemplate
          ? 'notifications.flushDueNotifications.recurring'
          : 'notifications.flushDueNotifications',
      )
      const sentAtIso = new Date().toISOString()

      if (isRecurringTemplate) {
        const sentRow = await insertSentNotificationInstance(pool, row, sentPayload, sentAtIso)
        scheduleOneSignalStatsRefresh(sentRow.id)
        await advanceRecurrenceTemplate(pool, row, sentAtIso)
      } else {
        await pool.query(
          `UPDATE notifications
           SET status = 'sent',
               delivery_state = 'sent',
               sent_at = COALESCE(sent_at, $2::timestamptz),
               updated_at = now(),
               payload = $3::jsonb
           WHERE id = $1`,
          [id, sentAtIso, JSON.stringify(sentPayload)],
        )
        scheduleOneSignalStatsRefresh(id)
      }
    } catch (e) {
      const failPayload = {
        ...sanitizePayload(row.payload),
        onesignal_error: String(e.message || e).slice(0, 2000),
      }
      if (isRecurringTemplate) {
        await pool.query(
          `UPDATE notifications
           SET delivery_state = 'failed', updated_at = now(), payload = $2::jsonb
           WHERE id = $1`,
          [id, JSON.stringify(failPayload)],
        )
      } else {
        await pool.query(
          `UPDATE notifications
           SET delivery_state = 'failed', updated_at = now(), payload = $2::jsonb
           WHERE id = $1`,
          [id, JSON.stringify(failPayload)],
        )
      }
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

  let destination
  try {
    destination = buildNotificationDestination(payload)
  } catch (e) {
    if (existing?.target_type) {
      destination = destinationFromPayloadAndTargetType(
        sanitizePayload(existing.payload),
        existing.target_type,
      )
    } else {
      throw e
    }
  }

  const basePayload = sanitizePayload(payload.payload ?? existing?.payload)
  const mergedPayload = mergeDestinationIntoPayload(basePayload, destination)
  const recurrence = normalizeRecurrenceFields(payload, existing, { status })

  return {
    kind: asNotificationKind(payload.kind ?? existing?.kind, 'admin'),
    title: text(payload.title ?? existing?.title, 200),
    message: text(payload.message ?? existing?.message, 4000),
    image: sanitizeImage(payload.image ?? existing?.image),
    targetAudience: 'all',
    targetType: destination.deepLink,
    destination,
    status,
    deliveryState: asDeliveryState(
      payload.deliveryState ?? payload.delivery_state ?? existing?.delivery_state,
      status === 'sent' ? 'sent' : 'pending',
    ),
    severity: asSeverity(payload.severity ?? existing?.severity, 'info'),
    sourceEvent: text(payload.sourceEvent ?? payload.source_event ?? existing?.source_event, 128),
    payload: mergedPayload,
    clicks: Math.max(0, Number(payload.clicks ?? existing?.clicks) || 0),
    isActive: shouldBeActive(status, payload.isActive ?? payload.is_active ?? existing?.is_active),
    scheduleAt,
    sentAt,
    expiresAt: asIsoOrNull(payload.expiresAt ?? payload.expires_at ?? existing?.expires_at),
    createdBy: text(payload.createdBy ?? payload.created_by ?? existing?.created_by, 120) || 'Admin',
    recurrenceKind: recurrence.recurrenceKind,
    recurrenceInterval: recurrence.recurrenceInterval,
    recurrenceUntil: recurrence.recurrenceUntil,
    recurrenceAnchorAt: recurrence.recurrenceAnchorAt ?? scheduleAt,
    isRecurrenceTemplate: recurrence.isRecurrenceTemplate,
    recurrenceParentId: existing?.recurrence_parent_id ?? null,
  }
}

export async function listNotificationsAdmin(req = null) {
  await flushDueNotifications()
  await syncStaleOneSignalStats()
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT *
     FROM notifications
     ORDER BY COALESCE(sent_at, schedule_at, created_at) DESC, created_at DESC`
  )
  return rows.map((row) => toApiNotification(row, req))
}

export async function listRuntimeNotifications({ audience = 'all' } = {}, req = null) {
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
  return rows.map((row) => toApiNotification(row, req))
}

export async function createAdminNotification(body, actor = 'Admin', req = null) {
  const next = normalizeAdminNotificationInput(body, null)
  if (!next.title) throw new Error('title is required')
  if (!next.message) throw new Error('message is required')
  const pool = requirePool()

  let imageForDb = next.image
  let pushImageUrl = ''
  let mergedPayload = { ...next.payload }
  let deliveryState = next.deliveryState

  if (next.kind === 'admin' && next.image) {
    const prepared = await prepareNotificationImageForPush(next.image)
    imageForDb = prepared.imageForDb
    pushImageUrl = prepared.pushImageUrl
  }

  if (next.kind === 'admin' && next.status === 'sent') {
    if (!isOneSignalConfigured()) {
      throw new Error(
        'OneSignal is not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY on the server, then retry.',
      )
    }
    const pushData = oneSignalDataFromDestination(next.destination)
    const result = await sendOneSignalNotification(
      {
        title: next.title,
        message: next.message,
        imageUrl: pushImageUrl,
        data: pushData,
      },
      { source: 'notifications.createAdminNotification' },
    )
    mergedPayload = {
      ...mergedPayload,
      onesignal_id: result.id,
      onesignal_recipients: result.recipients,
      onesignal_push_image_url: result.pushImageUrl,
      onesignal_image_skipped: result.imageSkipped || false,
      onesignal_image_skip_reason: result.imageSkipReason || null,
      onesignal_api_host: result.apiHost,
    }
    deliveryState = 'sent'
  }

  const { rows } = await pool.query(
    `INSERT INTO notifications (
       kind, title, message, image, target_audience, target_type, status, delivery_state,
       severity, source_event, payload, clicks, is_active, schedule_at, sent_at, expires_at,
       recurrence_kind, recurrence_interval, recurrence_until, recurrence_anchor_at,
       recurrence_parent_id, is_recurrence_template, created_by, updated_at
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, $11::jsonb, $12, $13, $14::timestamptz, $15::timestamptz, $16::timestamptz,
       $17, $18, $19::timestamptz, $20::timestamptz, $21::uuid, $22, $23, now()
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
      next.recurrenceKind,
      next.recurrenceInterval,
      next.recurrenceUntil,
      next.recurrenceAnchorAt,
      next.recurrenceParentId,
      next.isRecurrenceTemplate,
      text(actor, 120) || next.createdBy,
    ],
  )
  publishNotificationsChanged({ action: 'created', notificationId: rows[0]?.id })
  if (next.status === 'sent' && mergedPayload.onesignal_id) {
    scheduleOneSignalStatsRefresh(rows[0]?.id)
  }
  return toApiNotification(rows[0], req)
}

export async function updateNotificationById(id, body, actor = 'Admin', req = null) {
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
         recurrence_kind = $18,
         recurrence_interval = $19,
         recurrence_until = $20::timestamptz,
         recurrence_anchor_at = $21::timestamptz,
         is_recurrence_template = $22,
         created_by = $23,
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
      next.recurrenceKind,
      next.recurrenceInterval,
      next.recurrenceUntil,
      next.recurrenceAnchorAt,
      next.isRecurrenceTemplate,
      text(actor, 120) || next.createdBy,
    ],
  )
  publishNotificationsChanged({ action: 'updated', notificationId: rows[0]?.id })
  return toApiNotification(rows[0], req)
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

/** Deletes all rows shown in admin notification history. */
export async function deleteAllNotificationsAdmin() {
  const pool = requirePool()
  const { rowCount } = await pool.query(`DELETE FROM notifications`)
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
