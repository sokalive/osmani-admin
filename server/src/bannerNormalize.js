import { resolveThumbnailForApi } from './channelNormalize.js'
import { normalizeRuntimePosition } from './lib/bannerRuntimePosition.js'

/** Normalize PostgreSQL TIME / strings to HH:mm for API clients. */
export function formatTimeForApi(t) {
  if (t == null) return ''
  if (t instanceof Date && !Number.isNaN(t.getTime())) {
    return `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`
  }
  const s = String(t).trim()
  if (!s) return ''
  const m = /^(\d{1,2}):(\d{2})/.exec(s)
  if (m) {
    return `${String(Number(m[1])).padStart(2, '0')}:${m[2]}`
  }
  return ''
}

function formatTsForApi(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function fullImageUrl(row, req) {
  const imageRel = row.image ?? null
  return resolveThumbnailForApi(imageRel, req)
}

/**
 * GET /api/banners — runtime shape for public clients.
 * Server filters active + not past event_end only. Apps own pre-start COMING SOON,
 * LIVE NOW, countdown, daily event_timer, and enabled/tap gating.
 */
export function bannerToPublicResponse(row, req) {
  if (!row) return null
  const imageUrl = fullImageUrl(row, req)
  const eventStart = formatTsForApi(row.event_start)
  const eventEnd = formatTsForApi(row.event_end)
  const rid = row.redirect_channel_id != null ? Number(row.redirect_channel_id) : null
  const sortOrder = Number(row.sort_order) || 0
  const createdAt = formatTsForApi(row.created_at)
  const updatedAt = formatTsForApi(row.updated_at) ?? createdAt
  const startTime = formatTimeForApi(row.daily_start)
  const endTime = formatTimeForApi(row.daily_end)
  const runtimePosition = normalizeRuntimePosition(row.runtime_position)

  return {
    id: Number(row.id),
    title: row.title ?? '',
    description: row.description ?? '',
    image_url: imageUrl,
    imageUrl: imageUrl,
    is_active: Boolean(row.active),
    isActive: Boolean(row.active),
    enabled: Boolean(row.enabled),
    isEnabled: Boolean(row.enabled),
    badge: row.badge ?? '',
    badge_enabled: Boolean(row.badge_enabled),
    badgeEnabled: Boolean(row.badge_enabled),
    badge_color: String(row.badge_color ?? '#FBBF24').trim() || '#FBBF24',
    badgeColor: String(row.badge_color ?? '#FBBF24').trim() || '#FBBF24',
    badge_blink: Boolean(row.badge_blink),
    badgeBlink: Boolean(row.badge_blink),
    badge_priority: Number(row.badge_priority) || 0,
    badgePriority: Number(row.badge_priority) || 0,
    enable_countdown: Boolean(row.enable_countdown),
    enableCountdown: Boolean(row.enable_countdown),
    event_start: eventStart,
    eventStart,
    event_end: eventEnd,
    eventEnd,
    redirect_channel_id: rid,
    redirectChannelId: rid,
    sort_order: sortOrder,
    sortOrder,
    event_timer: Boolean(row.event_timer),
    eventTimer: Boolean(row.event_timer),
    useTimer: Boolean(row.event_timer),
    daily_start: startTime,
    dailyStart: startTime,
    startTime,
    daily_end: endTime,
    dailyEnd: endTime,
    endTime,
    runtime_position: runtimePosition,
    runtimePosition,
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
  }
}

/**
 * CMS / manage / mutate responses — full row + legacy daily timer fields for admin UI.
 */
export function bannerToResponse(row, req) {
  if (!row) return null
  const ca = row.created_at
  const ua = row.updated_at
  const imageUrl = fullImageUrl(row, req)
  const eventStart = formatTsForApi(row.event_start)
  const eventEnd = formatTsForApi(row.event_end)
  const rid = row.redirect_channel_id != null ? Number(row.redirect_channel_id) : null
  const sortOrder = Number(row.sort_order) || 0
  const createdIso = ca instanceof Date ? ca.toISOString() : formatTsForApi(ca)
  const updatedIso =
    (ua instanceof Date ? ua.toISOString() : formatTsForApi(ua)) ?? createdIso
  const runtimePosition = normalizeRuntimePosition(row.runtime_position)

  return {
    id: Number(row.id),
    title: row.title ?? '',
    description: row.description ?? '',
    image: imageUrl,
    image_url: imageUrl,
    imageUrl: imageUrl,
    isActive: Boolean(row.active),
    isEnabled: Boolean(row.enabled),
    badge: row.badge ?? '',
    badgeEnabled: Boolean(row.badge_enabled),
    badgeColor: String(row.badge_color ?? '#FBBF24').trim() || '#FBBF24',
    badgeBlink: Boolean(row.badge_blink),
    badgePriority: Number(row.badge_priority) || 0,
    enableCountdown: Boolean(row.enable_countdown),
    eventStart,
    eventEnd,
    redirectChannelId: rid,
    redirectChannel: row.redirect_channel_name != null ? String(row.redirect_channel_name) : '',
    sortOrder,
    useTimer: Boolean(row.event_timer),
    startTime: formatTimeForApi(row.daily_start),
    endTime: formatTimeForApi(row.daily_end),
    createdAt: createdIso,
    updatedAt: updatedIso,
    active: Boolean(row.active),
    enabled: Boolean(row.enabled),
    eventTimer: Boolean(row.event_timer),
    dailyStart: formatTimeForApi(row.daily_start),
    dailyEnd: formatTimeForApi(row.daily_end),
    is_active: Boolean(row.active),
    active: Boolean(row.active),
    badge_enabled: Boolean(row.badge_enabled),
    badge_color: String(row.badge_color ?? '#FBBF24').trim() || '#FBBF24',
    badge_blink: Boolean(row.badge_blink),
    badge_priority: Number(row.badge_priority) || 0,
    enable_countdown: Boolean(row.enable_countdown),
    event_start: eventStart,
    event_end: eventEnd,
    redirect_channel_id: rid,
    sort_order: sortOrder,
    runtime_position: runtimePosition,
    runtimePosition,
    created_at: createdIso,
    updated_at: updatedIso,
  }
}
