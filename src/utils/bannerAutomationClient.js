/**
 * Browser copy of server/src/bannerScheduleEngine.js — keep COMING_SOON threshold and phases in sync.
 * Used for admin modal preview only; production labels come from GET /api/banners.
 */
export const PREVIEW_COMING_SOON_HOURS = 72

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

function isBannerLiveNow(row, now = new Date()) {
  if (!row?.active) return false
  if (!isNowInEventWindow(row.event_start, row.event_end, now)) return false
  if (!row.event_timer) return true
  return isNowInDailyWindow(row.daily_start, row.daily_end, now)
}

function isWaitingForDailyWindow(row, now = new Date()) {
  if (!row?.active || !row.event_timer) return false
  if (!isNowInEventWindow(row.event_start, row.event_end, now)) return false
  if (isNowInDailyWindow(row.daily_start, row.daily_end, now)) return false
  return true
}

function isBannerEnded(row, now = new Date()) {
  if (row?.event_end == null || row.event_end === '') return false
  const e = new Date(row.event_end).getTime()
  if (Number.isNaN(e)) return false
  return now.getTime() >= e
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
    .sort((a, b) => {
      const da = eventStartMs(a)
      const db = eventStartMs(b)
      if (da !== db) return da - db
      return sortOrderKey(a) - sortOrderKey(b)
    })

  for (const row of rows) {
    const id = Number(row.id)
    if (!Number.isFinite(id)) continue

    if (isBannerEnded(row, now)) {
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
  return {
    id: Number(b.id),
    active: b.isActive !== false && b.active !== false,
    badge: b.badge ?? '',
    badge_automation: b.badgeAutomation !== false && b.badge_automation !== false,
    event_start: b.eventStart ?? b.event_start ?? null,
    event_end: b.eventEnd ?? b.event_end ?? null,
    event_timer: Boolean(b.useTimer ?? b.eventTimer ?? b.event_timer),
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
  return {
    id: draftId,
    active: form.isActive !== false,
    badge: form.badge ?? '',
    badge_automation: form.badgeAutomation !== false,
    event_start: es,
    event_end: ee,
    event_timer: Boolean(form.useTimer),
    daily_start: form.useTimer ? form.startTime : null,
    daily_end: form.useTimer ? form.endTime : null,
    sort_order: Number(form.sortOrder) || 0,
    enabled: form.isEnabled !== false,
  }
}

export function buildPreviewAutomationMap(peerBanners, draftRow, now = new Date()) {
  const peers = (peerBanners || []).map(manageApiRowToEngine).filter(Boolean)
  const filtered = peers.filter((p) => p.id !== draftRow.id)
  return computeAutomationForAll([...filtered, draftRow], now)
}
