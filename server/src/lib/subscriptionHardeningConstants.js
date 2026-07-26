/**
 * Permanent subscription hardening constants.
 * Canonical engine is the ONLY production entitlement engine.
 */

export const CANONICAL_ENGINE_VERSION = 'canonical-v1'
export const SUBSCRIPTION_SCHEMA_VERSION = 1

/** App-settings keys for global migration / engine lock. */
export const APP_SETTING_MIGRATION_COMPLETED = 'subscription_migration_completed'
export const APP_SETTING_CANONICAL_ENGINE = 'canonical_engine_version'
export const APP_SETTING_SCHEMA_VERSION = 'subscription_schema_version'
export const APP_SETTING_LEGACY_LOCK = 'subscription_legacy_lock'

/** Reasonable bounds for a single plan purchase (days). */
export const MAX_SINGLE_PLAN_DURATION_DAYS = 366
export const MIN_SINGLE_PLAN_DURATION_DAYS = 1

/**
 * Max remaining calendar days allowed for a NEW purchase write
 * (plan days + 1 for midnight-EAT boundary + small grace).
 */
export const NEW_PURCHASE_REMAINING_DAYS_GRACE = 2

/** Clock skew tolerance when comparing computed vs proposed expiry. */
export const EXPIRY_MS_TOLERANCE = 5 * 60 * 1000

/** Cache namespace / version — bump invalidates all in-process access cache entries. */
export const SUBSCRIPTION_ACCESS_CACHE_VERSION = 'cav1'

/** Integrity audit schedule slots (Africa/Dar_es_Salaam local hours). */
export const INTEGRITY_AUDIT_EAT_HOURS = Object.freeze([6, 14, 22])

export const ENTITLEMENT_GUARD_SOURCES = Object.freeze({
  PAYMENT: 'payment',
  MANUAL_GRANT: 'manual_grant',
  CUSTOM_GRANT: 'custom_grant',
  TRANSFER: 'transfer',
  RECOVERY: 'recovery',
  MIGRATION: 'migration',
  ADMIN_PUT: 'admin_put',
  REPAIR: 'repair',
  OTHER: 'other',
})
