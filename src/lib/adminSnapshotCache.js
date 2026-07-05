/** Session-scoped last-known-good admin snapshots (no secrets). */

const NS = 'osmani_admin_snap_v1'

function key(page) {
  const host = typeof window !== 'undefined' ? window.location.host : 'server'
  return `${NS}:${host}:${page}`
}

export function readAdminSnapshot(page) {
  if (typeof sessionStorage === 'undefined') return null
  try {
    const raw = sessionStorage.getItem(key(page))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return parsed.data ?? null
  } catch {
    return null
  }
}

export function writeAdminSnapshot(page, data) {
  if (typeof sessionStorage === 'undefined' || data == null) return
  try {
    sessionStorage.setItem(
      key(page),
      JSON.stringify({ savedAt: new Date().toISOString(), data }),
    )
  } catch {
    /* quota */
  }
}
