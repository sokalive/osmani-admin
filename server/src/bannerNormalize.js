import { resolveThumbnailForApi } from './channelNormalize.js'

function formatTimeForApi(t) {
  if (t == null) return ''
  const s = String(t).trim()
  if (!s) return ''
  return s.length >= 5 ? s.slice(0, 5) : s
}

function formatTsForApi(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * DB row (+ optional redirect_channel_name from join) → JSON for clients.
 */
export function bannerToResponse(row, req) {
  if (!row) return null
  const ca = row.created_at
  const imageRel = row.image ?? null
  const imageUrl = resolveThumbnailForApi(imageRel, req)
  const eventStart = formatTsForApi(row.event_start)
  const eventEnd = formatTsForApi(row.event_end)
  const rid = row.redirect_channel_id != null ? Number(row.redirect_channel_id) : null
  const sortOrder = Number(row.sort_order) || 0

  return {
    id: Number(row.id),
    title: row.title ?? '',
    description: row.description ?? '',
    image: imageUrl,
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
    createdAt: ca instanceof Date ? ca.toISOString() : ca,
    // Aliases matching DB names (optional for clients)
    active: Boolean(row.active),
    enabled: Boolean(row.enabled),
    eventTimer: Boolean(row.event_timer),
    dailyStart: formatTimeForApi(row.daily_start),
    dailyEnd: formatTimeForApi(row.daily_end),
    is_active: Boolean(row.active),
    badge_enabled: Boolean(row.badge_enabled),
    badge_color: String(row.badge_color ?? '#FBBF24').trim() || '#FBBF24',
    badge_blink: Boolean(row.badge_blink),
    badge_priority: Number(row.badge_priority) || 0,
    enable_countdown: Boolean(row.enable_countdown),
    event_start: eventStart,
    event_end: eventEnd,
    redirect_channel_id: rid,
    sort_order: sortOrder,
  }
}
