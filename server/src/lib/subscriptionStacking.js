const MS_PER_DAY = 24 * 60 * 60 * 1000
export const SUBSCRIPTION_TZ = 'Africa/Dar_es_Salaam'

/**
 * Calendar date parts in Africa/Dar_es_Salaam for an instant.
 * @param {number} [nowMs]
 */
export function eatDateParts(nowMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SUBSCRIPTION_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]))
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
  }
}

/**
 * Instant for YYYY-MM-DD 00:00:00 in Africa/Dar_es_Salaam (as UTC Date).
 * EAT is UTC+3 year-round (no DST).
 */
export function eatMidnightUtcIso(year, month, day) {
  const y = Number(year)
  const m = Number(month)
  const d = Number(day)
  // 00:00 EAT = 21:00 previous day UTC
  const utcMs = Date.UTC(y, m - 1, d, 0, 0, 0, 0) - 3 * 60 * 60 * 1000
  return new Date(utcMs).toISOString()
}

function addCalendarDays(year, month, day, addDays) {
  // Use UTC noon as stable calendar arithmetic carrier
  const utc = Date.UTC(year, month - 1, day, 12, 0, 0)
  const next = new Date(utc + addDays * MS_PER_DAY)
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  }
}

/**
 * New-subscription expiry: purchase calendar day (EAT) + durationDays at 00:00 EAT.
 * Example: buy 25 Jul any time, duration 7 → expire 1 Aug 00:00 EAT.
 */
export function computeMidnightEatExpiryIso(durationDays, nowMs = Date.now()) {
  const days = Math.max(1, Math.trunc(Number(durationDays) || 1))
  const today = eatDateParts(nowMs)
  const exp = addCalendarDays(today.year, today.month, today.day, days)
  return eatMidnightUtcIso(exp.year, exp.month, exp.day)
}

/**
 * Calendar remaining days until expiry date in EAT (display only; does not change expires_at).
 * expires Aug 1 00:00 EAT, now Jul 25 → 7.
 */
export function computeRemainingCalendarDaysEat(expiresAt, nowMs = Date.now()) {
  if (expiresAt == null || expiresAt === '') return 0
  const exp = expiresAt instanceof Date ? expiresAt : new Date(expiresAt)
  if (Number.isNaN(exp.getTime()) || exp.getTime() <= nowMs) return 0
  const nowParts = eatDateParts(nowMs)
  const expParts = eatDateParts(exp.getTime())
  const nowUtc = Date.UTC(nowParts.year, nowParts.month - 1, nowParts.day)
  const expUtc = Date.UTC(expParts.year, expParts.month - 1, expParts.day)
  return Math.max(0, Math.round((expUtc - nowUtc) / MS_PER_DAY))
}

/**
 * Pure expiry math for NEW subscriptions (midnight EAT).
 * Stacking is permanently disabled. If a previous future expiry exists (in-flight edge),
 * keep it unchanged so we never shorten an existing customer.
 *
 * @param {string | Date | null | undefined} previousExpiresAt
 * @param {number} durationDays
 * @param {number} [nowMs]
 */
export function computeStackedExpiryIso(previousExpiresAt, durationDays, nowMs = Date.now()) {
  const days = Math.max(1, Math.trunc(Number(durationDays) || 1))
  const now = new Date(nowMs)
  let previousIso = null
  let previousFuture = false
  if (previousExpiresAt != null && previousExpiresAt !== '') {
    const prev = previousExpiresAt instanceof Date ? previousExpiresAt : new Date(previousExpiresAt)
    if (!Number.isNaN(prev.getTime()) && prev.getTime() > now.getTime()) {
      previousIso = prev.toISOString()
      previousFuture = true
    }
  }

  // Never shorten an already-active entitlement (in-flight payment edge case).
  if (previousFuture) {
    return {
      expiresAt: previousIso,
      previousExpiresAt: previousIso,
      anchorAt: previousIso,
      purchasedDurationDays: days,
      stacked: false,
      stacking_disabled: true,
      expiry_policy: 'preserve_existing_active',
      timezone: SUBSCRIPTION_TZ,
    }
  }

  const expiresAt = computeMidnightEatExpiryIso(days, nowMs)
  return {
    expiresAt,
    previousExpiresAt: null,
    anchorAt: eatMidnightUtcIso(eatDateParts(nowMs).year, eatDateParts(nowMs).month, eatDateParts(nowMs).day),
    purchasedDurationDays: days,
    stacked: false,
    stacking_disabled: true,
    expiry_policy: 'midnight_africa_dar_es_salaam',
    timezone: SUBSCRIPTION_TZ,
  }
}
