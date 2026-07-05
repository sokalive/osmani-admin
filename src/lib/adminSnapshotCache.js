/** Session-scoped last-known-good admin snapshots (no secrets). */

const NS = 'osmani_admin_snap_v2'

function key(page) {
  const host = typeof window !== 'undefined' ? window.location.host : 'server'
  return `${NS}:${host}:${page}`
}

/** @deprecated v1 keys — read once for migration */
const NS_V1 = 'osmani_admin_snap_v1'

export function readAdminSnapshot(page) {
  if (typeof sessionStorage === 'undefined') return null
  try {
    let raw = sessionStorage.getItem(key(page))
    if (!raw) {
      const host = typeof window !== 'undefined' ? window.location.host : 'server'
      raw = sessionStorage.getItem(`${NS_V1}:${host}:${page}`)
    }
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
