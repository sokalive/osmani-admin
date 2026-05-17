/**
 * Daily window using local time. Times are "HH:mm" (24h).
 * Overnight windows (e.g. 22:00–06:00) are supported.
 */
export function parseTimeToMinutes(value) {
  if (value == null || typeof value !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  return h * 60 + min
}

export function isNowInDailyWindow(startTime, endTime, now = new Date()) {
  const start = parseTimeToMinutes(startTime)
  const end = parseTimeToMinutes(endTime)
  if (start == null || end == null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  if (start < end) {
    return cur >= start && cur < end
  }
  return cur >= start || cur < end
}

/**
 * Whether the banner is still eligible for the public API / carousel (not past event_end).
 * Pre-event_start is allowed — the app renders COMING SOON and counts down to event_start.
 */
export function isBannerEventNotExpired(eventEnd, now = new Date()) {
  const endRaw = eventEnd ?? null
  if (endRaw == null || endRaw === '') return true
  const e = new Date(endRaw).getTime()
  if (Number.isNaN(e)) return true
  return now.getTime() < e
}

/** @deprecated Use isBannerEventNotExpired for visibility; kept for admin phase labels. */
export function isNowInEventWindow(eventStart, eventEnd, now = new Date()) {
  return isBannerEventNotExpired(eventEnd, now)
}

/** upcoming | live | ended — for admin preview copy only; app owns production UX. */
export function getBannerEventPhase(eventStart, eventEnd, now = new Date()) {
  const t = now.getTime()
  const endRaw = eventEnd ?? null
  if (endRaw != null && endRaw !== '') {
    const e = new Date(endRaw).getTime()
    if (!Number.isNaN(e) && t >= e) return 'ended'
  }
  const startRaw = eventStart ?? null
  if (startRaw != null && startRaw !== '') {
    const s = new Date(startRaw).getTime()
    if (!Number.isNaN(s) && t < s) return 'upcoming'
  }
  return 'live'
}

function isBannerActiveFlag(banner) {
  if (!banner || typeof banner !== 'object') return false
  if (banner.isActive === false || banner.is_active === false || banner.active === false) return false
  return true
}

/** Admin preview: active, not expired, optional daily timer (matches public API + app rules). */
export function isBannerShownInCarousel(banner, now = new Date()) {
  if (!isBannerActiveFlag(banner)) return false
  const ee = banner.eventEnd ?? banner.event_end
  if (!isBannerEventNotExpired(ee, now)) return false
  const useTimer = Boolean(banner.useTimer ?? banner.eventTimer ?? banner.event_timer)
  if (!useTimer) return true
  const start = banner.startTime ?? banner.dailyStart ?? banner.daily_start ?? ''
  const end = banner.endTime ?? banner.dailyEnd ?? banner.daily_end ?? ''
  return isNowInDailyWindow(start, end, now)
}

/** End-user can tap / navigate — requires enabled AND currently shown. */
export function canBannerReceiveInteractions(banner, now = new Date()) {
  return Boolean(banner?.isEnabled) && isBannerShownInCarousel(banner, now)
}
