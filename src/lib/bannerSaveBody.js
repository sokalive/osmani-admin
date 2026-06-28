import { normalizeRuntimePosition } from '../../server/src/lib/bannerRuntimePosition.js'

const BANNER_SAVE_DEBUG =
  typeof import.meta !== 'undefined' && import.meta.env?.DEV === true

function debugLog(label, data) {
  if (!BANNER_SAVE_DEBUG) return
  console.info(`[banner-save] ${label}`, data)
}

function resolveTriStateFlag(m, keys, defaultVal = true) {
  for (const key of keys) {
    if (m[key] === true) return true
    if (m[key] === false) return false
  }
  return defaultVal
}

/**
 * Canonical JSON body for POST/PUT /api/banners.
 * Matches mobile GET /api/banners fields: title, description, event_timer, redirect_channel_id,
 * daily_start/end, runtime_position (overlay mode).
 */
export function bannerSaveBody(b, overrides = {}) {
  const m = { ...b, ...overrides }
  const useTimer = Boolean(m.useTimer ?? m.eventTimer ?? m.event_timer)
  const sortOrder = Number(m.sortOrder ?? m.sort_order) || 0
  const runtime = normalizeRuntimePosition(m.runtimePosition ?? m.runtime_position)
  const dailyStart = useTimer ? (m.startTime ?? m.dailyStart ?? m.daily_start ?? '09:00') : ''
  const dailyEnd = useTimer ? (m.endTime ?? m.dailyEnd ?? m.daily_end ?? '17:00') : ''

  const body = {
    title: m.title ?? '',
    description: m.description ?? '',
    image: m.image ?? m.imageUrl ?? m.image_url ?? '',
    badge: m.badge ?? '',
    badgeEnabled: m.badgeEnabled ?? m.badge_enabled ?? true,
    badgeColor: (m.badgeColor ?? m.badge_color ?? '#FBBF24').trim() || '#FBBF24',
    badgeBlink: Boolean(m.badgeBlink ?? m.badge_blink),
    badgePriority: Number(m.badgePriority ?? m.badge_priority) || 0,
    enableCountdown: Boolean(m.enableCountdown ?? m.enable_countdown),
    eventStart: m.eventStart ?? m.event_start ?? null,
    eventEnd: m.eventEnd ?? m.event_end ?? null,
    redirectChannelId: (() => {
      const v = m.redirectChannelId ?? m.redirect_channel_id
      if (v === '' || v == null) return null
      const n = Number(v)
      return Number.isFinite(n) ? n : null
    })(),
    sortOrder,
    active: resolveTriStateFlag(m, ['isActive', 'active', 'is_active'], true),
    isActive: resolveTriStateFlag(m, ['isActive', 'active', 'is_active'], true),
    enabled: resolveTriStateFlag(m, ['isEnabled', 'enabled', 'is_enabled'], true),
    isEnabled: resolveTriStateFlag(m, ['isEnabled', 'enabled', 'is_enabled'], true),
    useTimer,
    event_timer: useTimer,
    eventTimer: useTimer,
    startTime: dailyStart,
    endTime: dailyEnd,
    daily_start: dailyStart,
    daily_end: dailyEnd,
    runtimePosition: runtime,
    runtime_position: runtime,
  }

  debugLog('bannerSaveBody', {
    runtime_position: body.runtime_position,
    runtimePosition: body.runtimePosition,
    title: body.title,
  })

  return body
}
