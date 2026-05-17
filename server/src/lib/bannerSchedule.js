/**
 * Banner schedule helpers (aligned with admin src/utils/bannerSchedule.js).
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

export function isBannerEventNotExpired(eventEnd, now = new Date()) {
  const endRaw = eventEnd ?? null
  if (endRaw == null || endRaw === '') return true
  const e = new Date(endRaw).getTime()
  if (Number.isNaN(e)) return true
  return now.getTime() < e
}

export function isNowInEventWindow(_eventStart, eventEnd, now = new Date()) {
  return isBannerEventNotExpired(eventEnd, now)
}

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

export function isBannerActiveFlag(banner) {
  if (!banner || typeof banner !== 'object') return false
  if (banner.isActive === false || banner.is_active === false || banner.active === false) return false
  return true
}

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
