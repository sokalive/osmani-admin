/** Mpingo authorized package name — optional per-channel metadata. */
export const AUTHORIZED_PACKAGE_NAME_MAX = 128

const PACKAGE_NAME_RE = /^[\p{L}\p{N}\s._\-'()+/]+$/u

/**
 * Normalize optional authorized package name (trim, collapse whitespace, cap length).
 * Empty input → '' (backward compatible: no Mpingo override).
 */
export function normalizeAuthorizedPackageName(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, AUTHORIZED_PACKAGE_NAME_MAX)
  return s
}

/**
 * @returns {string | null} Error message when invalid; null when ok (including empty).
 */
export function validateAuthorizedPackageName(value) {
  const v = normalizeAuthorizedPackageName(value)
  if (!v) return null
  if (v.length > AUTHORIZED_PACKAGE_NAME_MAX) {
    return `authorizedPackageName must be at most ${AUTHORIZED_PACKAGE_NAME_MAX} characters`
  }
  if (!PACKAGE_NAME_RE.test(v)) {
    return 'authorizedPackageName contains unsupported characters'
  }
  return null
}

export function logChannelAuthorizedPackageAudit(action, details = {}) {
  console.log(
    '[channel_audit]',
    JSON.stringify({
      action,
      scope: 'authorized_package_name',
      timestamp: new Date().toISOString(),
      ...details,
    }),
  )
}
