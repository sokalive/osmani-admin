/**
 * Recurring notification schedules — templates stay scheduled; each fire inserts a sent row.
 */

export const RECURRENCE_KINDS = new Set([
  'once',
  'daily',
  'weekly',
  'monthly',
  'interval_minutes',
  'interval_hours',
])

export function isRecurringKind(kind) {
  const k = String(kind ?? 'once').toLowerCase()
  return k !== 'once' && RECURRENCE_KINDS.has(k)
}

export function normalizeRecurrenceKind(value, fallback = 'once') {
  const k = String(value ?? fallback)
    .trim()
    .toLowerCase()
  return RECURRENCE_KINDS.has(k) ? k : fallback
}

export function normalizeRecurrenceInterval(kind, value) {
  const k = normalizeRecurrenceKind(kind)
  if (k !== 'interval_minutes' && k !== 'interval_hours') return null
  const n = Math.trunc(Number(value) || 1)
  const max = k === 'interval_minutes' ? 10_080 : 168
  return Math.max(1, Math.min(max, n))
}

export function normalizeRecurrenceFields(body, existing = null, { status } = {}) {
  const raw = body && typeof body === 'object' ? body : {}
  const kind = normalizeRecurrenceKind(
    raw.recurrenceKind ?? raw.recurrence_kind ?? existing?.recurrence_kind,
    'once',
  )
  const interval = normalizeRecurrenceInterval(
    kind,
    raw.recurrenceInterval ?? raw.recurrence_interval ?? existing?.recurrence_interval,
  )
  const untilRaw = raw.recurrenceUntil ?? raw.recurrence_until ?? existing?.recurrence_until
  const recurrenceUntil =
    untilRaw != null && untilRaw !== '' && !Number.isNaN(new Date(untilRaw).getTime())
      ? new Date(untilRaw).toISOString()
      : null

  const scheduleAt = raw.scheduleAt ?? raw.schedule_at ?? existing?.schedule_at
  const anchorRaw =
    raw.recurrenceAnchorAt ??
    raw.recurrence_anchor_at ??
    existing?.recurrence_anchor_at ??
    scheduleAt
  const recurrenceAnchorAt =
    anchorRaw != null && anchorRaw !== '' && !Number.isNaN(new Date(anchorRaw).getTime())
      ? new Date(anchorRaw).toISOString()
      : null

  const isRecurrenceTemplate = status === 'scheduled' && isRecurringKind(kind)

  if (status === 'sent' && isRecurringKind(kind)) {
    throw new Error('Instant send supports one-time notifications only. Use schedule for recurring.')
  }
  if (isRecurringKind(kind) && status === 'scheduled' && !scheduleAt) {
    throw new Error('scheduleAt is required for recurring notifications')
  }
  if (
    (kind === 'interval_minutes' || kind === 'interval_hours') &&
    (!interval || interval < 1)
  ) {
    throw new Error('recurrenceInterval must be at least 1 for interval schedules')
  }

  return {
    recurrenceKind: kind,
    recurrenceInterval: interval,
    recurrenceUntil,
    recurrenceAnchorAt,
    isRecurrenceTemplate,
  }
}

/**
 * @param {object} opts
 * @param {Date|string} opts.from - scheduled occurrence that fired (calendar) or last fire time (interval)
 * @param {string} opts.kind
 * @param {number|null} opts.interval
 * @param {Date|string|null} opts.anchorAt - first scheduled time (daily/weekly/monthly alignment)
 */
export function computeNextScheduleAt({ from, kind, interval, anchorAt }) {
  const k = normalizeRecurrenceKind(kind)
  if (k === 'once') return null

  const fromDate = new Date(from)
  if (Number.isNaN(fromDate.getTime())) return null
  const anchor = anchorAt ? new Date(anchorAt) : fromDate
  if (Number.isNaN(anchor.getTime())) return null

  if (k === 'interval_minutes') {
    const mins = normalizeRecurrenceInterval(k, interval) || 1
    return new Date(fromDate.getTime() + mins * 60_000).toISOString()
  }
  if (k === 'interval_hours') {
    const hrs = normalizeRecurrenceInterval(k, interval) || 1
    return new Date(fromDate.getTime() + hrs * 3_600_000).toISOString()
  }

  if (k === 'daily') {
    const next = new Date(fromDate)
    next.setUTCDate(next.getUTCDate() + 1)
    next.setUTCHours(anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), 0)
    return next.toISOString()
  }
  if (k === 'weekly') {
    const next = new Date(fromDate)
    next.setUTCDate(next.getUTCDate() + 7)
    next.setUTCHours(anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), 0)
    return next.toISOString()
  }
  if (k === 'monthly') {
    const next = new Date(fromDate)
    next.setUTCMonth(next.getUTCMonth() + 1)
    next.setUTCHours(anchor.getUTCHours(), anchor.getUTCMinutes(), anchor.getUTCSeconds(), 0)
    return next.toISOString()
  }
  return null
}

/** Calendar recurrence advances from the scheduled occurrence, not send latency. */
export function recurrenceAdvanceFrom({ kind, scheduleAt, sentAtIso }) {
  const k = normalizeRecurrenceKind(kind)
  if ((k === 'daily' || k === 'weekly' || k === 'monthly') && scheduleAt != null && scheduleAt !== '') {
    const d = new Date(scheduleAt)
    if (!Number.isNaN(d.getTime())) return d.toISOString()
  }
  return sentAtIso
}

export function recurrenceKindLabel(kind, interval) {
  const k = normalizeRecurrenceKind(kind)
  if (k === 'once') return 'Once'
  if (k === 'daily') return 'Daily'
  if (k === 'weekly') return 'Weekly'
  if (k === 'monthly') return 'Monthly'
  if (k === 'interval_minutes') return `Every ${interval || 1} min`
  if (k === 'interval_hours') return `Every ${interval || 1} hr`
  return k
}
