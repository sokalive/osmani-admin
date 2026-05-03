export function parseIso(iso) {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : d
}

export function remainingMs(expiryIso, now = new Date()) {
  const end = parseIso(expiryIso)
  if (!end) return null
  return end.getTime() - now.getTime()
}

/** Human-readable remaining time; expired → null ms handled by caller */
export function formatRemaining(ms) {
  if (ms == null || ms <= 0) return 'Expired'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

export function subscriptionStatus(expiryIso, now = new Date()) {
  const ms = remainingMs(expiryIso, now)
  if (ms == null) return 'expired'
  return ms > 0 ? 'active' : 'expired'
}
