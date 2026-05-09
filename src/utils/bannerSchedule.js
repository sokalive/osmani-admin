/** Bits 0–6 = Sun–Sat (matches `Date#getDay()`). Default 127 = all days. */
const WEEKDAY_MASK_ALL = 127

function isWeekdayAllowed(mask, now = new Date()) {
  const raw = mask == null || mask === '' ? WEEKDAY_MASK_ALL : Number(mask)
  if (!Number.isFinite(raw) || raw < 0) return false
  if (raw === 0) return false
  const day = now.getDay()
  return (raw & (1 << day)) !== 0
}

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

/** Event range from API (ISO strings or null). Open-ended when one bound missing. */
export function isNowInEventWindow(eventStart, eventEnd, now = new Date()) {
  const startRaw = eventStart ?? null
  const endRaw = eventEnd ?? null
  if ((startRaw == null || startRaw === '') && (endRaw == null || endRaw === '')) return true
  const t = now.getTime()
  if (startRaw != null && startRaw !== '') {
    const s = new Date(startRaw).getTime()
    if (!Number.isNaN(s) && t < s) return false
  }
  if (endRaw != null && endRaw !== '') {
    const e = new Date(endRaw).getTime()
    if (!Number.isNaN(e) && t >= e) return false
  }
  return true
}

/** Active + event window + legacy daily schedule: banner appears in the carousel / hero strip. */
export function isBannerShownInCarousel(banner, now = new Date()) {
  if (!banner?.isActive) return false
  const es = banner.eventStart ?? banner.event_start
  const ee = banner.eventEnd ?? banner.event_end
  if (!isNowInEventWindow(es, ee, now)) return false
  if (!banner?.useTimer) return true
  const mask = banner.weekdayMask ?? banner.weekday_mask ?? WEEKDAY_MASK_ALL
  if (!isWeekdayAllowed(mask, now)) return false
  return isNowInDailyWindow(banner.startTime, banner.endTime, now)
}

/** End-user can tap / navigate — requires enabled AND currently shown. */
export function canBannerReceiveInteractions(banner, now = new Date()) {
  return Boolean(banner?.isEnabled) && isBannerShownInCarousel(banner, now)
}
