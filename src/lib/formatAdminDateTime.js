/**
 * Admin panel display-only date/time helpers.
 * Parses ISO/epoch timestamps and formats in the viewer's local timezone (no fixed IANA zone).
 * Does not modify stored values or backend behavior.
 */

/** Swahili month names (Mei, Aprili, …); time uses local wall clock. */
export const ADMIN_DATETIME_LOCALE = 'sw'

function coerceDate(value) {
  if (value == null || value === '') return null
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value
  }
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/**
 * Full local datetime: "17 Mei 2026 9:15 PM" style (12-hour, locale month names).
 */
export function formatAdminDateTime(value, { fallback = '—' } = {}) {
  const d = coerceDate(value)
  if (!d) return fallback
  try {
    return new Intl.DateTimeFormat(ADMIN_DATETIME_LOCALE, {
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
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d)
  } catch {
    return fallback
  }
}

/** Short time for charts / compact UI (local 12-hour). */
export function formatAdminTimeShort(value, { fallback = '—' } = {}) {
  const d = coerceDate(value)
  if (!d) return fallback
  try {
    return new Intl.DateTimeFormat(ADMIN_DATETIME_LOCALE, {
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
