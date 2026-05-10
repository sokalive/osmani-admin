const STORAGE_KEY = 'osmani_admin_panel_device_uid'

/**
 * Stable raw fingerprint string sent to API (server hashes with salt).
 */
export function getAdminDeviceFingerprintRaw() {
  if (typeof window === 'undefined') return ''
  try {
    let uid = localStorage.getItem(STORAGE_KEY)
    if (!uid) {
      uid = crypto.randomUUID()
      localStorage.setItem(STORAGE_KEY, uid)
    }
    const ua = navigator.userAgent || 'unknown'
    return `${ua}|${uid}`
  } catch {
    return `fallback|${Date.now()}`
  }
}
