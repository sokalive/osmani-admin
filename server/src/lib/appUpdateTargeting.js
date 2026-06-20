/**
 * App update popup targeting — only Play Store v15 cohort gets SOFT/FORCE when enabled.
 * v16–23: VPS OTA migrated — no popup.
 * v24+: never prompted.
 */

export function parseVersionCode(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.trunc(n)
}

/** Only this client versionCode receives admin SOFT/FORCE (default 15). */
export const APP_UPDATE_POPUP_TARGET_VERSION = Math.max(
  1,
  parseVersionCode(process.env.APP_UPDATE_POPUP_TARGET_VERSION) || 15,
)

/** Inclusive — VPS OTA migration cohort; never re-prompt. */
export const APP_UPDATE_VPS_MIGRATION_MIN = Math.max(
  1,
  parseVersionCode(process.env.APP_UPDATE_VPS_MIGRATION_MIN) || 16,
)
export const APP_UPDATE_VPS_MIGRATION_MAX = Math.max(
  APP_UPDATE_VPS_MIGRATION_MIN,
  parseVersionCode(process.env.APP_UPDATE_VPS_MIGRATION_MAX) || 23,
)

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
  if (client >= APP_UPDATE_VPS_MIGRATION_MIN && client <= APP_UPDATE_VPS_MIGRATION_MAX) {
    return { ...out, decision: 'NONE', update_target_reason: 'vps_ota_migration_cohort' }
  }
  if (client === APP_UPDATE_POPUP_TARGET_VERSION) {
    return { ...out, update_target_reason: 'v15_play_store_cohort' }
  }
  return { ...out, decision: 'NONE', update_target_reason: 'not_target_version' }
}

export function clientVersionFromRequest(req) {
  const b = req?.body && typeof req.body === 'object' ? req.body : {}
  const q = req?.query && typeof req.query === 'object' ? req.query : {}
  return parseVersionCode(
    b.version_code ?? b.versionCode ?? q.version_code ?? q.versionCode ?? 0,
  )
}
