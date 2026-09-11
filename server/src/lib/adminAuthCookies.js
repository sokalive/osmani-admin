/**
 * HttpOnly Secure SameSite cookies for admin session + trusted-device credential.
 * Cookie parsing is intentional (no cookie-parser dependency).
 *
 * Defaults align with the fixed 14-day trusted-device window (336 hours).
 */

export const ADMIN_SESSION_COOKIE = 'osmani_admin_session'
export const ADMIN_DEVICE_COOKIE = 'osmani_admin_device'

/** Exact trust window: 14 days = 336 hours (overridable via ADMIN_TRUSTED_DEVICE_DAYS). */
export function adminTrustedDeviceDays() {
  return Math.min(90, Math.max(1, Number(process.env.ADMIN_TRUSTED_DEVICE_DAYS) || 14))
}

export function adminSessionCookieDays() {
  return Math.min(
    90,
    Math.max(1, Number(process.env.ADMIN_SESSION_COOKIE_DAYS) || adminTrustedDeviceDays()),
  )
}

export function adminDeviceCookieDays() {
  return Math.min(
    730,
    Math.max(1, Number(process.env.ADMIN_DEVICE_COOKIE_DAYS) || adminTrustedDeviceDays()),
  )
}

export function parseCookieHeader(req) {
  const raw = String(req?.headers?.cookie ?? '')
  /** @type {Record<string, string>} */
  const out = {}
  if (!raw) return out
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx <= 0) continue
    const key = part.slice(0, idx).trim()
    if (!key) continue
    let value = part.slice(idx + 1).trim()
    try {
      value = decodeURIComponent(value)
    } catch {
      /* keep raw */
    }
    out[key] = value
  }
  return out
}

export function readAdminSessionToken(req) {
  const auth = String(req?.headers?.authorization ?? '')
  const m = /^Bearer\s+(.+)$/i.exec(auth)
  if (m) return m[1].trim()
  const cookies = parseCookieHeader(req)
  return String(cookies[ADMIN_SESSION_COOKIE] ?? '').trim()
}

export function readAdminDeviceCredential(req) {
  const header = String(req?.headers?.['x-admin-device-credential'] ?? '').trim()
  if (header) return header
  const cookies = parseCookieHeader(req)
  return String(cookies[ADMIN_DEVICE_COOKIE] ?? '').trim()
}

function cookieSecure(req) {
  if (String(process.env.ADMIN_COOKIE_SECURE ?? '').trim().toLowerCase() === '1') return true
  if (String(process.env.ADMIN_COOKIE_SECURE ?? '').trim().toLowerCase() === '0') return false
  const xf = String(req?.headers?.['x-forwarded-proto'] ?? '').split(',')[0].trim().toLowerCase()
  if (xf === 'https') return true
  return Boolean(req?.secure)
}

function appendSetCookie(res, value) {
  const prev = res.getHeader('Set-Cookie')
  if (!prev) {
    res.setHeader('Set-Cookie', value)
    return
  }
  const list = Array.isArray(prev) ? prev.slice() : [String(prev)]
  list.push(value)
  res.setHeader('Set-Cookie', list)
}

function buildCookie(name, value, { maxAgeSec, secure, clear = false } = {}) {
  const parts = [
    `${name}=${clear ? '' : encodeURIComponent(String(value ?? ''))}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
  ]
  if (secure) parts.push('Secure')
  if (clear) {
    parts.push('Max-Age=0')
    parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT')
  } else if (maxAgeSec != null) {
    parts.push(`Max-Age=${Math.max(0, Number(maxAgeSec) || 0)}`)
  }
  return parts.join('; ')
}

export function setAdminAuthCookies(res, req, { sessionToken, deviceCredential, maxAgeSec } = {}) {
  const secure = cookieSecure(req)
  const sessionDays = adminSessionCookieDays()
  const deviceDays = adminDeviceCookieDays()
  const sessionMax =
    maxAgeSec != null ? Math.max(60, Number(maxAgeSec) || 60) : sessionDays * 86400
  if (sessionToken) {
    appendSetCookie(
      res,
      buildCookie(ADMIN_SESSION_COOKIE, sessionToken, {
        maxAgeSec: sessionMax,
        secure,
      }),
    )
  }
  if (deviceCredential) {
    appendSetCookie(
      res,
      buildCookie(ADMIN_DEVICE_COOKIE, deviceCredential, {
        // Device cookie Max-Age matches fixed trust window (not slid on session refresh).
        maxAgeSec: deviceDays * 86400,
        secure,
      }),
    )
  }
}

/** Clear session JWT cookie only — preserves trusted-device credential cookie. */
export function clearAdminSessionCookie(res, req) {
  const secure = cookieSecure(req)
  appendSetCookie(res, buildCookie(ADMIN_SESSION_COOKIE, '', { clear: true, secure }))
}

export function clearAdminDeviceCookie(res, req) {
  const secure = cookieSecure(req)
  appendSetCookie(res, buildCookie(ADMIN_DEVICE_COOKIE, '', { clear: true, secure }))
}

export function clearAdminAuthCookies(res, req) {
  clearAdminSessionCookie(res, req)
  clearAdminDeviceCookie(res, req)
}
