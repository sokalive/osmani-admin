/**
 * Server-side banner scheduling + automatic badge labels (LIVE NOW, COMING SOON, COMING NEXT, ENDED).
 * Mirrors client logic in src/utils/bannerSchedule.js — keep behavior aligned when changing rules.
 */

function parseTimeToMinutes(value) {
  if (value == null) return null
  const s = String(value).trim()
  const m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s)
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null
  return h * 60 + min
}

function formatTimeFromPg(t) {
  if (t == null) return '09:00'
  const s = String(t).trim()
  if (s.length >= 5 && /^\d{1,2}:\d{2}/.test(s)) return s.slice(0, 5)
  return s
}

export function isNowInDailyWindow(startTime, endTime, now = new Date()) {
  const start = parseTimeToMinutes(formatTimeFromPg(startTime))
  const end = parseTimeToMinutes(formatTimeFromPg(endTime))
  if (start == null || end == null) return false
  const cur = now.getHours() * 60 + now.getMinutes()
  if (start === end) return false
  if (start < end) {
    return cur >= start && cur < end
  }
  return cur >= start || cur < end
}

/** Bits 0–6 = Sun–Sat (matches `Date#getDay()`). Default 127 = all days. */
export const WEEKDAY_MASK_ALL = 127
export const ENDED_GRACE_MS = 3 * 60 * 1000
function usesDailyRepeat(row) {
  const mode = String(row?.repeat_mode ?? '').trim().toLowerCase()
  return mode === 'daily' || Boolean(row?.event_timer)
}

export function isWeekdayAllowed(mask, now = new Date()) {
  const raw = mask == null || mask === '' ? WEEKDAY_MASK_ALL : Number(mask)
  if (!Number.isFinite(raw) || raw < 0) return false
  if (raw === 0) return false
  const day = now.getDay()
  return (raw & (1 << day)) !== 0
}

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

export function isBannerLiveNow(row, now = new Date()) {
  if (!row?.active) return false
  if (!isNowInEventWindow(row.event_start, row.event_end, now)) return false
  if (!usesDailyRepeat(row)) return true
  const mask = row.weekday_mask ?? WEEKDAY_MASK_ALL
  if (!isWeekdayAllowed(mask, now)) return false
  return isNowInDailyWindow(row.daily_start, row.daily_end, now)
}

/** In event date range but not currently live (wrong weekday, outside daily window, etc.). */
export function isWaitingForDailyWindow(row, now = new Date()) {
  if (!row?.active || !usesDailyRepeat(row)) return false
  if (!isNowInEventWindow(row.event_start, row.event_end, now)) return false
  return !isBannerLiveNow(row, now)
}

export function isBannerEnded(row, now = new Date()) {
  if (row?.event_end == null || row.event_end === '') return false
  const e = new Date(row.event_end).getTime()
  if (Number.isNaN(e)) return false
  return now.getTime() >= e
}

function endedDeltaMs(row, now = new Date()) {
  if (row?.event_end == null || row.event_end === '') return null
  const e = new Date(row.event_end).getTime()
  if (Number.isNaN(e)) return null
  return now.getTime() - e
}

function formatHoursMinutes(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0:00'
  const totalMin = Math.max(1, Math.ceil(ms / 60000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return `${h}:${String(m).padStart(2, '0')}`
}

export function comingSoonHours() {
  const n = Number(process.env.BANNER_COMING_SOON_HOURS ?? '72')
  return Number.isFinite(n) && n > 0 ? n : 72
}

function sortOrderKey(row) {
  return Number(row.sort_order) || 0
}

function eventStartMs(row) {
  if (row.event_start == null || row.event_start === '') return Infinity
  const t = new Date(row.event_start).getTime()
  return Number.isNaN(t) ? Infinity : t
}

/**
 * Assign schedule_phase and display badge for each public banner row.
 * @returns {Map<number, { schedule_phase: string, computed_badge: string, display_badge: string }>}
 */
export function computeAutomationForAll(rows, now = new Date()) {
  const map = new Map()
  const soonMs = comingSoonHours() * 3600 * 1000
  const t = now.getTime()

  const alive = rows.filter((r) => r && r.active !== false && !isBannerEnded(r, now))

  const upcoming = alive
    .filter((r) => {
      if (!r.event_start) return false
      const s = new Date(r.event_start).getTime()
      return !Number.isNaN(s) && s > t
    })

  const firstUpcoming =
    [...upcoming].sort((a, b) => {
      const da = eventStartMs(a)
      const db = eventStartMs(b)
      if (da !== db) return da - db
      return sortOrderKey(a) - sortOrderKey(b)
    })[0] ?? null

  for (const row of rows) {
    const id = Number(row.id)
    if (!Number.isFinite(id)) continue

    if (isBannerEnded(row, now)) {
      const deltaEnded = endedDeltaMs(row, now)
      if (deltaEnded != null && deltaEnded > ENDED_GRACE_MS && firstUpcoming) {
        const nextStart = eventStartMs(firstUpcoming)
        const wait = nextStart - t
        map.set(id, {
          schedule_phase: 'COMING_SOON',
          computed_badge: 'COMING SOON',
          display_badge: `NEXT COMING SOON ${formatHoursMinutes(wait)}`,
        })
        continue
      }
      map.set(id, {
        schedule_phase: 'ENDED',
        computed_badge: 'ENDED',
        display_badge: 'ENDED',
      })
      continue
    }

    if (!row.active) {
      map.set(id, {
        schedule_phase: 'INACTIVE',
        computed_badge: '',
        display_badge: '',
      })
      continue
    }

    if (isBannerLiveNow(row, now)) {
      map.set(id, {
        schedule_phase: 'LIVE_NOW',
        computed_badge: 'LIVE NOW',
        display_badge: 'LIVE NOW',
      })
      continue
    }

    if (isWaitingForDailyWindow(row, now)) {
      map.set(id, {
        schedule_phase: 'COMING_SOON',
        computed_badge: 'COMING SOON',
        display_badge: 'COMING SOON',
      })
      continue
    }

    const idx = upcoming.findIndex((r) => Number(r.id) === id)
    if (idx < 0) {
      map.set(id, {
        schedule_phase: 'SCHEDULED',
        computed_badge: '',
        display_badge: '',
      })
      continue
    }

    const startMs = eventStartMs(row)
    const delta = startMs - t
    if (idx === 0 && delta <= soonMs) {
      map.set(id, {
        schedule_phase: 'COMING_SOON',
        computed_badge: 'COMING SOON',
        display_badge: 'COMING SOON',
      })
      continue
    }

    map.set(id, {
      schedule_phase: 'COMING_NEXT',
      computed_badge: 'COMING NEXT',
      display_badge: 'COMING NEXT',
    })
  }

  return map
}

/** Effective badge text for API: automation vs manual DB badge. */
export function resolveDisplayBadge(row, automationEntry) {
  const auto = row.badge_automation !== false && row.badge_automation !== 0
  if (!auto) {
    return String(row.badge ?? '').trim()
  }
  if (!automationEntry) return String(row.badge ?? '').trim()
  const d = String(automationEntry.display_badge ?? '').trim()
  return d || String(row.badge ?? '').trim()
}
