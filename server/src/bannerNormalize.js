import {
  isBannerLiveNow,
  resolveDisplayBadge,
} from './bannerScheduleEngine.js'
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

function fullImageUrl(row, req) {
  const imageRel = row.image ?? null
  return resolveThumbnailForApi(imageRel, req)
}

/**
 * GET /api/banners — production public shape only (no legacy timer / enabled fields).
 * Includes snake_case + camelCase aliases where applicable.
 * `badge` is the effective label (automation or manual). Pass automationEntry from computeAutomationForAll.
 */
export function bannerToPublicResponse(row, req, automationEntry = null, now = new Date()) {
  if (!row) return null
  const imageUrl = fullImageUrl(row, req)
  const eventStart = formatTsForApi(row.event_start)
  const eventEnd = formatTsForApi(row.event_end)
  const rid = row.redirect_channel_id != null ? Number(row.redirect_channel_id) : null
  const sortOrder = Number(row.sort_order) || 0
  const repeatMode = String(row.repeat_mode ?? '').trim().toLowerCase() === 'daily' ? 'daily' : 'none'
  const timezone = row.timezone == null ? '' : String(row.timezone)
  const weekdayMask =
    row.weekday_mask != null && row.weekday_mask !== ''
      ? Math.min(127, Math.max(0, Number(row.weekday_mask)))
      : 127
  const createdAt = formatTsForApi(row.created_at)
  const updatedAt = formatTsForApi(row.updated_at) ?? createdAt
  const badgeAutomation = row.badge_automation !== false && row.badge_automation !== 0
  const effectiveBadge = resolveDisplayBadge(row, automationEntry)
  const useTimer = repeatMode === 'daily' || Boolean(row.event_timer)

  return {
    id: Number(row.id),
    title: row.title ?? '',
    description: row.description ?? '',
    image_url: imageUrl,
    imageUrl: imageUrl,
    is_active: Boolean(row.active),
    isActive: Boolean(row.active),
    badge: effectiveBadge,
    badge_manual: String(row.badge ?? '').trim(),
    badgeManual: String(row.badge ?? '').trim(),
    badge_automation: badgeAutomation,
    badgeAutomation,
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
    created_at: createdAt,
    createdAt,
    updated_at: updatedAt,
    updatedAt,
    schedule_phase: automationEntry?.schedule_phase ?? null,
    schedulePhase: automationEntry?.schedule_phase ?? null,
    computed_badge: automationEntry?.computed_badge ?? '',
    computedBadge: automationEntry?.computed_badge ?? '',
    is_visible_now: isBannerLiveNow(row, now),
    isVisibleNow: isBannerLiveNow(row, now),
    can_interact: Boolean(row.enabled) && isBannerLiveNow(row, now),
    canInteract: Boolean(row.enabled) && isBannerLiveNow(row, now),
    event_timer: useTimer,
    eventTimer: useTimer,
    repeat_mode: repeatMode,
    repeatMode,
    timezone,
    daily_start: formatTimeForApi(row.daily_start),
    dailyStart: formatTimeForApi(row.daily_start),
    daily_end: formatTimeForApi(row.daily_end),
    dailyEnd: formatTimeForApi(row.daily_end),
    weekday_mask: weekdayMask,
    weekdayMask,
  }
}

/**
 * CMS / manage / mutate responses — full row + legacy daily timer fields for admin UI.
 * `badge` stays manual DB copy for editors; `effectiveBadge` is what users see when automation is on.
 */
export function bannerToResponse(row, req, automationEntry = null, now = new Date()) {
  if (!row) return null
  const ca = row.created_at
  const ua = row.updated_at
  const imageUrl = fullImageUrl(row, req)
  const eventStart = formatTsForApi(row.event_start)
  const eventEnd = formatTsForApi(row.event_end)
  const rid = row.redirect_channel_id != null ? Number(row.redirect_channel_id) : null
  const sortOrder = Number(row.sort_order) || 0
  const repeatMode = String(row.repeat_mode ?? '').trim().toLowerCase() === 'daily' ? 'daily' : 'none'
  const timezone = row.timezone == null ? '' : String(row.timezone)
  const weekdayMask =
    row.weekday_mask != null && row.weekday_mask !== ''
      ? Math.min(127, Math.max(0, Number(row.weekday_mask)))
      : 127
  const createdIso = ca instanceof Date ? ca.toISOString() : formatTsForApi(ca)
  const updatedIso =
    (ua instanceof Date ? ua.toISOString() : formatTsForApi(ua)) ?? createdIso
  const effectiveBadge = resolveDisplayBadge(row, automationEntry)
  const useTimer = repeatMode === 'daily' || Boolean(row.event_timer)

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
    effectiveBadge,
    badgeAutomation: row.badge_automation !== false && row.badge_automation !== 0,
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
    useTimer,
    repeatMode,
    timezone,
    startTime: formatTimeForApi(row.daily_start),
    endTime: formatTimeForApi(row.daily_end),
    createdAt: createdIso,
    updatedAt: updatedIso,
    active: Boolean(row.active),
    enabled: Boolean(row.enabled),
    eventTimer: useTimer,
    repeat_mode: repeatMode,
    repeatMode,
    timezone,
    dailyStart: formatTimeForApi(row.daily_start),
    dailyEnd: formatTimeForApi(row.daily_end),
    weekdayMask,
    weekday_mask: weekdayMask,
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
    created_at: createdIso,
    updated_at: updatedIso,
    badge_automation: row.badge_automation !== false && row.badge_automation !== 0,
    schedulePhase: automationEntry?.schedule_phase ?? null,
    schedule_phase: automationEntry?.schedule_phase ?? null,
    computedBadge: automationEntry?.computed_badge ?? '',
    computed_badge: automationEntry?.computed_badge ?? '',
    isVisibleNow: isBannerLiveNow(row, now),
    is_visible_now: isBannerLiveNow(row, now),
  }
}
