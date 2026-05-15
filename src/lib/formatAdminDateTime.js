/**
 * Admin panel display-only date/time helpers.
 * Parses ISO timestamps and formats in Africa/Dar_es_Salaam (12-hour, AM/PM).
 * Does not modify stored values or backend behavior.
 */

export const ADMIN_DISPLAY_TIMEZONE = 'Africa/Dar_es_Salaam'

/** English labels for consistency with AM/PM in the admin shell. */
export const ADMIN_DATETIME_LOCALE = 'en-GB'

function coerceDate(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Full datetime in Dar es Salaam: e.g. "17 May 2026, 9:15 pm"
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
