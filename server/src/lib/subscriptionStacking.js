const MS_PER_DAY = 24 * 60 * 60 * 1000

/**
 * Pure stacking math: add durationDays × 24h on top of remaining active time.
 * @param {string | Date | null | undefined} previousExpiresAt
 * @param {number} durationDays
 * @param {number} [nowMs]
 */
export function computeStackedExpiryIso(previousExpiresAt, durationDays, nowMs = Date.now()) {
  const days = Math.max(1, Math.trunc(Number(durationDays) || 1))
  const now = new Date(nowMs)
  let anchor = now
  let previousIso = null
  if (previousExpiresAt != null && previousExpiresAt !== '') {
    const prev = previousExpiresAt instanceof Date ? previousExpiresAt : new Date(previousExpiresAt)
    if (!Number.isNaN(prev.getTime()) && prev.getTime() > now.getTime()) {
      anchor = prev
      previousIso = prev.toISOString()
    }
  }
  const expiresAt = new Date(anchor.getTime() + days * MS_PER_DAY).toISOString()
  return {
    expiresAt,
    previousExpiresAt: previousIso,
    anchorAt: anchor.toISOString(),
    purchasedDurationDays: days,
    stacked: Boolean(previousIso),
  }
}
