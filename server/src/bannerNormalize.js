import { resolveThumbnailForApi } from './channelNormalize.js'

function formatTimeForApi(t) {
  if (t == null) return ''
  const s = String(t).trim()
  if (!s) return ''
  return s.length >= 5 ? s.slice(0, 5) : s
}

/**
 * DB row (+ optional redirect_channel_name from join) → JSON for clients.
 */
export function bannerToResponse(row, req) {
  if (!row) return null
  const ca = row.created_at
  const imageRel = row.image ?? null
  const imageUrl = resolveThumbnailForApi(imageRel, req)

  return {
    id: Number(row.id),
    title: row.title ?? '',
    description: row.description ?? '',
    image: imageUrl,
    isActive: Boolean(row.active),
    isEnabled: Boolean(row.enabled),
    badge: row.badge ?? '',
    redirectChannelId: row.redirect_channel_id != null ? Number(row.redirect_channel_id) : null,
    redirectChannel: row.redirect_channel_name != null ? String(row.redirect_channel_name) : '',
    sortOrder: Number(row.sort_order) || 0,
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
  }
}
