/**
 * Owner entitlement policy (production):
 * - Subscriptions are device-bound; phone is payment/contact metadata only.
 * - No automatic cross-device entitlement movement (verify, status, fingerprint, phone, install, etc.).
 * - Only explicit Hamisha (commitSubscriptionTransfer) or authorized Admin transfer may relocate access.
 * - Active devices cannot create another payment (ACTIVE_SUBSCRIPTION_EXISTS); stacking is permanently disabled.
 * - New subscriptions expire at 00:00 Africa/Dar_es_Salaam after duration_days (existing expiries untouched).
 */

export const UNAUTHORIZED_MIGRATION_REASON = 'automatic_cross_device_migration_disabled'

/** @returns {boolean} true when automatic A→B writers must not run */
export function isAutomaticCrossDeviceMigrationBlocked() {
  return process.env.ALLOW_AUTOMATIC_SUBSCRIPTION_MIGRATION !== '1'
}

/**
 * @param {{ explicitAuthorizedTransfer?: boolean }} [opts]
 * @returns {{ recovered?: boolean, linked?: boolean, reason: string } | null}
 */
export function rejectUnauthorizedCrossDeviceMigration(opts = {}) {
  if (opts.explicitAuthorizedTransfer === true) return null
  if (!isAutomaticCrossDeviceMigrationBlocked()) return null
  return { recovered: false, linked: false, reason: UNAUTHORIZED_MIGRATION_REASON }
}
