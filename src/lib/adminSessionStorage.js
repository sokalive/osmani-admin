export const ADMIN_TOKEN_KEY = 'osmani_admin_token'
export const ADMIN_EMAIL_KEY = 'osmani_admin_email'
export const PENDING_OTP_KEY = 'osmani_admin_pending_otp_token'
export const PENDING_EMAIL_KEY = 'osmani_admin_pending_email'

function readLegacySessionToken() {
  if (typeof sessionStorage === 'undefined') return null
  return sessionStorage.getItem(ADMIN_TOKEN_KEY)
}

/** Persistent admin JWT — migrates one-time from sessionStorage. */
export function getAdminSessionToken() {
  if (typeof localStorage === 'undefined') return readLegacySessionToken()
  const stored = localStorage.getItem(ADMIN_TOKEN_KEY)
  if (stored) return stored
  const legacy = readLegacySessionToken()
  if (legacy) {
    localStorage.setItem(ADMIN_TOKEN_KEY, legacy)
    sessionStorage.removeItem(ADMIN_TOKEN_KEY)
  }
  return legacy
}

export function getAdminSessionEmail() {
  if (typeof localStorage === 'undefined') {
    return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(ADMIN_EMAIL_KEY) : null
  }
  const stored = localStorage.getItem(ADMIN_EMAIL_KEY)
  if (stored) return stored
  const legacy =
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(ADMIN_EMAIL_KEY) : null
  if (legacy) {
    localStorage.setItem(ADMIN_EMAIL_KEY, legacy)
    sessionStorage.removeItem(ADMIN_EMAIL_KEY)
  }
  return legacy
}

export function setAdminSessionToken(token) {
  if (token) {
    localStorage.setItem(ADMIN_TOKEN_KEY, token)
    sessionStorage.removeItem(ADMIN_TOKEN_KEY)
  } else {
    localStorage.removeItem(ADMIN_TOKEN_KEY)
    sessionStorage.removeItem(ADMIN_TOKEN_KEY)
  }
}

export function setAdminSessionEmail(email) {
  if (email) {
    localStorage.setItem(ADMIN_EMAIL_KEY, email)
    sessionStorage.removeItem(ADMIN_EMAIL_KEY)
  } else {
    localStorage.removeItem(ADMIN_EMAIL_KEY)
    sessionStorage.removeItem(ADMIN_EMAIL_KEY)
  }
}

export function clearAdminSession() {
  setAdminSessionToken(null)
  setAdminSessionEmail(null)
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.removeItem(PENDING_OTP_KEY)
    sessionStorage.removeItem(PENDING_EMAIL_KEY)
  }
}

export function adminJwtExpiresAtMs(token) {
  const t = String(token ?? '').trim()
  if (!t) return null
  const parts = t.split('.')
  if (parts.length !== 3) return null
  try {
    const pad = 4 - (parts[1].length % 4 || 4)
    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad === 4 ? 0 : pad)
    const payload = JSON.parse(atob(b64))
    const exp = Number(payload?.exp)
    return Number.isFinite(exp) ? exp * 1000 : null
  } catch {
    return null
  }
}

export function adminJwtNeedsRefresh(token, withinMs = 3600_000) {
  const expMs = adminJwtExpiresAtMs(token)
  if (!expMs) return false
  return expMs - Date.now() <= withinMs
}
