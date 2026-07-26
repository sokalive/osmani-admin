/** Persistent last-known-good admin snapshots (no secrets).
 * sessionStorage for in-tab speed + localStorage so reopen feels instant.
 */

const NS = 'osmani_admin_snap_v2'
/** Dashboard / analytics may show briefly while live refresh runs. */
const DEFAULT_MAX_AGE_MS = 10 * 60 * 1000

function hostKey() {
  return typeof window !== 'undefined' ? window.location.host : 'server'
}

function key(page) {
  return `${NS}:${hostKey()}:${page}`
}

/** @deprecated v1 keys — read once for migration */
const NS_V1 = 'osmani_admin_snap_v1'

function readRaw(storage, storageKey) {
  if (!storage) return null
  try {
    return storage.getItem(storageKey)
  } catch {
    return null
  }
}

function writeRaw(storage, storageKey, value) {
  if (!storage) return
  try {
    storage.setItem(storageKey, value)
  } catch {
    /* quota / private mode */
  }
}

/**
 * @param {string} page
 * @param {{ maxAgeMs?: number }} [opts]
 * @returns {object|null}
 */
export function readAdminSnapshot(page, opts = {}) {
  if (typeof window === 'undefined') return null
  const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  try {
    let raw =
      readRaw(window.sessionStorage, key(page)) ||
      readRaw(window.localStorage, key(page)) ||
      readRaw(window.sessionStorage, `${NS_V1}:${hostKey()}:${page}`)
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.savedAt && maxAgeMs > 0) {
      const age = Date.now() - new Date(parsed.savedAt).getTime()
      if (Number.isFinite(age) && age > maxAgeMs) {
        // Still return data for instant paint — callers always background-refresh.
        // Age is exposed via readAdminSnapshotMeta when needed.
      }
    }
    return parsed.data ?? null
  } catch {
    return null
  }
}

export function readAdminSnapshotMeta(page) {
  if (typeof window === 'undefined') return null
  try {
    const raw =
      readRaw(window.sessionStorage, key(page)) || readRaw(window.localStorage, key(page))
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    return { savedAt: parsed.savedAt ?? null, data: parsed.data ?? null }
  } catch {
    return null
  }
}

export function writeAdminSnapshot(page, data) {
  if (typeof window === 'undefined' || data == null) return
  const payload = JSON.stringify({ savedAt: new Date().toISOString(), data })
  writeRaw(window.sessionStorage, key(page), payload)
  writeRaw(window.localStorage, key(page), payload)
}
