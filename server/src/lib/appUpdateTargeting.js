/**
 * App update popup targeting — users below catalog versionCode 24 get admin SOFT/FORCE.
 * v24+: never prompted (installed stable cohort).
 */

export function parseVersionCode(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

/** v24+ never see update popup. */
export const APP_UPDATE_NEVER_MIN = Math.max(
  1,
  parseVersionCode(process.env.APP_UPDATE_NEVER_MIN) || 24,
)

/**
 * @param {Record<string, unknown>} data — output of toPublicConfig()
 * @param {unknown} clientVersionInput
 * @returns {Record<string, unknown>}
 */
export function applyAppUpdateClientDecision(data, clientVersionInput) {
  const client = parseVersionCode(clientVersionInput)
  const out = {
    ...(data && typeof data === 'object' ? data : {}),
    decision: String(data?.decision ?? 'NONE').toUpperCase(),
  }

  if (client <= 0) {
    return { ...out, decision: 'NONE', update_target_reason: 'unknown_client_version' }
  }
  if (client >= APP_UPDATE_NEVER_MIN) {
    return { ...out, decision: 'NONE', update_target_reason: 'version_24_plus' }
  }
  return { ...out, update_target_reason: 'below_catalog_version' }
}

export function clientVersionFromRequest(req) {
  const b = req?.body && typeof req.body === 'object' ? req.body : {}
  const q = req?.query && typeof req.query === 'object' ? req.query : {}
  return parseVersionCode(
    b.version_code ?? b.versionCode ?? q.version_code ?? q.versionCode ?? 0,
  )
}
