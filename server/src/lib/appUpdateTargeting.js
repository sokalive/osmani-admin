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
 * Admin flags → public decision. Auto Download is non-cancelable (same as Force Update).
 * @param {{ soft?: boolean, force?: boolean, autoDownload?: boolean, versionCode?: number, hasAnyUrl?: boolean }} opts
 */
export function resolveAppUpdateDecision(opts = {}) {
  const soft = opts.soft === true
  const force = opts.force === true
  const autoDownload = opts.autoDownload === true
  const versionCode = parseVersionCode(opts.versionCode)
  const hasAnyUrl = opts.hasAnyUrl === true

  let decision = 'NONE'
  if (force) decision = 'FORCE'
  else if (soft) decision = 'SOFT'

  if (autoDownload) {
    if (decision !== 'NONE') {
      decision = 'FORCE'
    } else if (versionCode > 0 && hasAnyUrl) {
      decision = 'FORCE'
    }
  }
  return decision
}

/** Client-facing mirrors for legacy APKs (cancel / force / soft). */
export function enrichAppUpdateClientFields(data) {
  const base = data && typeof data === 'object' ? data : {}
  const decision = String(base.decision ?? 'NONE').toUpperCase()
  const forceUpdate = decision === 'FORCE'
  const softUpdate = decision === 'SOFT'
  return {
    ...base,
    decision,
    cancelable: softUpdate,
    dismissible: softUpdate,
    force_update: forceUpdate,
    soft_update: softUpdate,
    update_mode: decision.toLowerCase(),
    force: forceUpdate,
  }
}

/**
 * @param {Record<string, unknown>} data — output of toPublicConfig()
 * @param {unknown} clientVersionInput
 * @returns {Record<string, unknown>}
 */
export function applyAppUpdateClientDecision(data, clientVersionInput) {
  const client = parseVersionCode(clientVersionInput)
  const out = enrichAppUpdateClientFields({
    ...(data && typeof data === 'object' ? data : {}),
    decision: String(data?.decision ?? 'NONE').toUpperCase(),
  })

  if (client <= 0) {
    return enrichAppUpdateClientFields({
      ...out,
      decision: 'NONE',
      update_target_reason: 'unknown_client_version',
    })
  }
  if (client >= APP_UPDATE_NEVER_MIN) {
    return enrichAppUpdateClientFields({
      ...out,
      decision: 'NONE',
      update_target_reason: 'version_24_plus',
    })
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
