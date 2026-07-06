/**
 * Admin panel display-only date/time helpers.
 * Parses ISO timestamps and formats in Africa/Dar_es_Salaam (12-hour, AM/PM).
 * Does not modify stored values or backend behavior.
 */

export const ADMIN_DISPLAY_TIMEZONE = 'Africa/Dar_es_Salaam'

/** English labels — en-US yields uppercase AM/PM per owner requirement. */
export const ADMIN_DATETIME_LOCALE = 'en-US'

function coerceDate(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Full datetime in Dar es Salaam: e.g. "May 17, 2026, 9:15 AM"
 */
export function formatAdminDateTime(value, { fallback = '—' } = {}) {
  const d = coerceDate(value)
  if (!d) return fallback
  try {
    return new Intl.DateTimeFormat(ADMIN_DATETIME_LOCALE, {
      timeZone: ADMIN_DISPLAY_TIMEZONE,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d)
  } catch {
    return fallback
  }
}

/** Date only (no time), for banner cards etc. */
export function formatAdminDateOnly(value, { fallback = '' } = {}) {
  const d = coerceDate(value)
  if (!d) return fallback
  try {
    return new Intl.DateTimeFormat(ADMIN_DATETIME_LOCALE, {
      timeZone: ADMIN_DISPLAY_TIMEZONE,
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d)
  } catch {
    return fallback
  }
}

/** Short time for charts / compact UI (12-hour, Dar es Salaam). */
export function formatAdminTimeShort(value, { fallback = '—' } = {}) {
  const d = coerceDate(value)
  if (!d) return fallback
  try {
    return new Intl.DateTimeFormat(ADMIN_DATETIME_LOCALE, {
      timeZone: ADMIN_DISPLAY_TIMEZONE,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(d)
  } catch {
    return fallback
  }
}

/** Back-compat alias used across older components */
export const formatReadableDateTime = formatAdminDateTime

/**
 * EAT wall-clock display for admin tables/modals (24-hour).
 * e.g. "16/05/2026, 15:30:00"
 */
export function formatAdminDateTime24h(value, { fallback = '—' } = {}) {
  const d = coerceDate(value)
  if (!d) return fallback
  try {
    return new Intl.DateTimeFormat(ADMIN_DATETIME_LOCALE, {
      timeZone: ADMIN_DISPLAY_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    }).format(d)
  } catch {
    return fallback
  }
}

/**
 * UTC ISO → `datetime-local` value interpreted as EAT wall time (YYYY-MM-DDTHH:mm).
 */
export function isoToAdminDatetimeLocal(iso) {
  const d = coerceDate(iso)
  if (!d) return ''
  try {
    const parts = new Intl.DateTimeFormat(ADMIN_DATETIME_LOCALE, {
      timeZone: ADMIN_DISPLAY_TIMEZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(d)
    const pick = (type) => parts.find((p) => p.type === type)?.value ?? ''
    return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}`
  } catch {
    return ''
  }
}

/**
 * EAT wall time from `datetime-local` → UTC ISO for API storage.
 * Dar es Salaam has no DST (fixed UTC+3).
 */
/** EAT calendar date `YYYY-MM-DD` from stored UTC ISO. */
export function adminDateFromIso(iso) {
  const local = isoToAdminDatetimeLocal(iso)
  return local ? local.slice(0, 10) : ''
}

/** EAT wall time `HH:mm` from stored UTC ISO. */
export function adminTimeFromIso(iso) {
  const local = isoToAdminDatetimeLocal(iso)
  return local ? local.slice(11, 16) : ''
}

/** EAT date + time fields → UTC ISO for API (`schedule_at`). */
export function adminDateAndTimeToIso(dateStr, timeStr) {
  const d = String(dateStr ?? '').trim()
  const t = String(timeStr ?? '').trim()
  if (!d || !t) return null
  return adminDatetimeLocalToIso(`${d}T${t}`)
}

export function adminDatetimeLocalToIso(local) {
  const s = String(local ?? '').trim()
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/)
  if (!m) return null
  const y = Number(m[1])
  const mo = Number(m[2])
  const d = Number(m[3])
  const h = Number(m[4])
  const mi = Number(m[5])
  if ([y, mo, d, h, mi].some((n) => !Number.isFinite(n))) return null
  const utcMs = Date.UTC(y, mo - 1, d, h - 3, mi, 0, 0)
  const iso = new Date(utcMs).toISOString()
  return isoToAdminDatetimeLocal(iso) === s ? iso : null
}

/** Human-readable remaining time from an expiry ISO (client clock). */
export function formatAdminRemainingFromExpiry(expiryIso, now = new Date()) {
  if (expiryIso == null || expiryIso === '') return '—'
  const end = coerceDate(expiryIso)
  if (!end) return '—'
  const ms = end.getTime() - now.getTime()
  if (ms <= 0) return 'Expired'
  const s = Math.floor(ms / 1000)
  const days = Math.floor(s / 86400)
  const hours = Math.floor((s % 86400) / 3600)
  const minutes = Math.floor((s % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h ${minutes}m`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}
