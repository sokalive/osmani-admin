/**
 * Browser copy of server/src/bannerScheduleEngine.js — keep COMING_SOON threshold and phases in sync.
 * Used for admin modal preview only; production labels come from GET /api/banners.
 */
export const PREVIEW_COMING_SOON_HOURS = 72
export const WEEKDAY_MASK_ALL = 127
export const ENDED_GRACE_MS = 3 * 60 * 1000
function usesDailyRepeat(row) {
  const mode = String(row?.repeat_mode ?? '').trim().toLowerCase()
  return mode === 'daily' || Boolean(row?.event_timer)
}

const DAY_ABBREV = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/** Short label for weekday bitmask (Sun=0 … Sat=6). */
export function formatWeekdayMaskAbbrev(mask, { allLabel = 'Every day' } = {}) {
  const m = mask == null || mask === '' ? WEEKDAY_MASK_ALL : Number(mask)
  if (!Number.isFinite(m) || m <= 0) return ''
  if ((m & 127) === 127) return allLabel
  const parts = []
  for (let d = 0; d < 7; d += 1) {
    if (m & (1 << d)) parts.push(DAY_ABBREV[d])
  }
  return parts.join(' · ')
}

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

function isNowInDailyWindow(startTime, endTime, now = new Date()) {
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

function isNowInEventWindow(eventStart, eventEnd, now = new Date()) {
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

function isWeekdayAllowed(mask, now = new Date()) {
  const raw = mask == null || mask === '' ? WEEKDAY_MASK_ALL : Number(mask)
  if (!Number.isFinite(raw) || raw < 0) return false
  if (raw === 0) return false
  const day = now.getDay()
  return (raw & (1 << day)) !== 0
}

function isBannerLiveNow(row, now = new Date()) {
  if (!row?.active) return false
  if (!isNowInEventWindow(row.event_start, row.event_end, now)) return false
  if (!usesDailyRepeat(row)) return true
  const mask = row.weekday_mask ?? WEEKDAY_MASK_ALL
  if (!isWeekdayAllowed(mask, now)) return false
  return isNowInDailyWindow(row.daily_start, row.daily_end, now)
}

function isWaitingForDailyWindow(row, now = new Date()) {
  if (!row?.active || !usesDailyRepeat(row)) return false
  if (!isNowInEventWindow(row.event_start, row.event_end, now)) return false
  return !isBannerLiveNow(row, now)
}

function isBannerEnded(row, now = new Date()) {
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

function sortOrderKey(row) {
  return Number(row.sort_order) || 0
}

function eventStartMs(row) {
  if (row.event_start == null || row.event_start === '') return Infinity
  const t = new Date(row.event_start).getTime()
  return Number.isNaN(t) ? Infinity : t
}

export function computeAutomationForAll(rows, now = new Date()) {
  const map = new Map()
  const soonMs = PREVIEW_COMING_SOON_HOURS * 3600 * 1000
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

/** Map GET /api/banners/manage row → engine row */
export function manageApiRowToEngine(b) {
  if (!b) return null
  const repeatMode = String(b.repeatMode ?? b.repeat_mode ?? '').trim().toLowerCase()
  const wm =
    b.weekdayMask != null && b.weekdayMask !== ''
      ? Number(b.weekdayMask)
      : b.weekday_mask != null && b.weekday_mask !== ''
        ? Number(b.weekday_mask)
        : WEEKDAY_MASK_ALL
  return {
    id: Number(b.id),
    active: b.isActive !== false && b.active !== false,
    badge: b.badge ?? '',
    badge_automation: b.badgeAutomation !== false && b.badge_automation !== false,
    event_start: b.eventStart ?? b.event_start ?? null,
    event_end: b.eventEnd ?? b.event_end ?? null,
    repeat_mode: repeatMode === 'daily' ? 'daily' : 'none',
    event_timer:
      repeatMode === 'daily' || Boolean(b.useTimer ?? b.eventTimer ?? b.event_timer),
    weekday_mask: Number.isFinite(wm) ? Math.min(127, Math.max(0, wm)) : WEEKDAY_MASK_ALL,
    daily_start: b.dailyStart ?? b.startTime ?? null,
    daily_end: b.dailyEnd ?? b.endTime ?? null,
    sort_order: Number(b.sortOrder ?? b.sort_order) || 0,
    enabled: b.isEnabled !== false,
  }
}

export function datetimeLocalToIso(local) {
  if (!local || !String(local).trim()) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

/** Draft row from modal form for preview (sync with submit payload). */
export function formToEngineRow(form, draftId) {
  const es = datetimeLocalToIso(form.eventStartLocal)
  const ee = datetimeLocalToIso(form.eventEndLocal)
  const repeatMode = String(form.repeatMode ?? '').trim().toLowerCase()
  const useTimer = repeatMode === 'daily' || Boolean(form.useTimer)
  const wmRaw = Number(form.weekdayMask)
  const weekday_mask = useTimer
    ? Number.isFinite(wmRaw)
      ? Math.min(127, Math.max(0, Math.floor(wmRaw)))
      : WEEKDAY_MASK_ALL
    : WEEKDAY_MASK_ALL
  return {
    id: draftId,
    active: form.isActive !== false,
    badge: form.badge ?? '',
    badge_automation: form.badgeAutomation !== false,
    event_start: es,
    event_end: ee,
    repeat_mode: useTimer ? 'daily' : 'none',
    event_timer: useTimer,
    weekday_mask,
    daily_start: useTimer ? form.startTime : null,
    daily_end: useTimer ? form.endTime : null,
    sort_order: Number(form.sortOrder) || 0,
    enabled: form.isEnabled !== false,
  }
}

export function buildPreviewAutomationMap(peerBanners, draftRow, now = new Date()) {
  const peers = (peerBanners || []).map(manageApiRowToEngine).filter(Boolean)
  const filtered = peers.filter((p) => p.id !== draftRow.id)
  return computeAutomationForAll([...filtered, draftRow], now)
}
