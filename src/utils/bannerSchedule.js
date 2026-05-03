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

/** Active + schedule: banner appears in the carousel / hero strip. */
export function isBannerShownInCarousel(banner, now = new Date()) {
  if (!banner?.isActive) return false
  if (!banner?.useTimer) return true
  return isNowInDailyWindow(banner.startTime, banner.endTime, now)
}

/** End-user can tap / navigate — requires enabled AND currently shown. */
export function canBannerReceiveInteractions(banner, now = new Date()) {
  return Boolean(banner?.isEnabled) && isBannerShownInCarousel(banner, now)
}
