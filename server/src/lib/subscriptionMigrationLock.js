/**
 * Migration Lock — migrated subscriptions permanently belong to the canonical architecture.
 * Old migration / historical apply / legacy repair write paths must not execute again.
 */
import { getPool } from '../db/pool.js'
import {
  APP_SETTING_CANONICAL_ENGINE,
  APP_SETTING_LEGACY_LOCK,
  APP_SETTING_MIGRATION_COMPLETED,
  APP_SETTING_SCHEMA_VERSION,
  CANONICAL_ENGINE_VERSION,
  SUBSCRIPTION_SCHEMA_VERSION,
} from './subscriptionHardeningConstants.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

export class MigrationLockError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'MigrationLockError'
    this.code = code
  }
}

export async function getAppSetting(key) {
  const pool = getPool()
  if (!pool) return null
  const { rows } = await pool.query(`SELECT value FROM app_settings WHERE key = $1 LIMIT 1`, [
    String(key),
  ])
  return rows[0]?.value != null ? String(rows[0].value) : null
}

export async function setAppSetting(key, value) {
  const pool = requirePool()
  await pool.query(
    `INSERT INTO app_settings (key, value, updated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [String(key), String(value)],
  )
}

export async function isSubscriptionMigrationCompleted() {
  const v = await getAppSetting(APP_SETTING_MIGRATION_COMPLETED)
  return v === 'true' || v === '1'
}

export async function isLegacySubscriptionLockEnabled() {
  const v = await getAppSetting(APP_SETTING_LEGACY_LOCK)
  // Default ON once migration completed; also ON if unset in production hardening.
  if (v == null || v === '') return true
  return v === 'true' || v === '1'
}

/**
 * One-time (idempotent) seal: mark global migration complete + stamp engine versions.
 * Safe to call on every startup.
 */
export async function ensureSubscriptionMigrationLockSealed() {
  const pool = getPool()
  if (!pool) return { sealed: false, reason: 'no_pool' }

  await setAppSetting(APP_SETTING_CANONICAL_ENGINE, CANONICAL_ENGINE_VERSION)
  await setAppSetting(APP_SETTING_SCHEMA_VERSION, String(SUBSCRIPTION_SCHEMA_VERSION))
  await setAppSetting(APP_SETTING_LEGACY_LOCK, 'true')

  const already = await isSubscriptionMigrationCompleted()
  if (!already) {
    await setAppSetting(APP_SETTING_MIGRATION_COMPLETED, 'true')
  }

  // Stamp rows that lack version markers (idempotent).
  await pool.query(
    `UPDATE device_subscriptions
     SET subscription_schema_version = COALESCE(subscription_schema_version, $1),
         canonical_engine_version = COALESCE(NULLIF(trim(canonical_engine_version), ''), $2),
         migration_completed_at = COALESCE(migration_completed_at, now())
     WHERE subscription_schema_version IS NULL
        OR canonical_engine_version IS NULL
        OR trim(COALESCE(canonical_engine_version, '')) = ''
        OR migration_completed_at IS NULL`,
    [SUBSCRIPTION_SCHEMA_VERSION, CANONICAL_ENGINE_VERSION],
  )

  return {
    sealed: true,
    migration_completed: true,
    canonical_engine_version: CANONICAL_ENGINE_VERSION,
    subscription_schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    legacy_lock: true,
  }
}

/**
 * Block historical normalization / legacy migration apply forever after seal.
 */
export async function assertHistoricalMigrationWritesBlocked(action = 'migration_apply') {
  if (await isSubscriptionMigrationCompleted()) {
    throw new MigrationLockError(
      'MIGRATION_LOCKED',
      `Migration Lock: ${action} is permanently disabled — production already migrated to ${CANONICAL_ENGINE_VERSION}`,
    )
  }
}

/**
 * Block any named legacy write path when legacy lock is on.
 */
export async function assertLegacyWritePathBlocked(pathName) {
  if (await isLegacySubscriptionLockEnabled()) {
    throw new MigrationLockError(
      'LEGACY_LOCKED',
      `Legacy Lock: ${pathName} is permanently disabled. Canonical engine ${CANONICAL_ENGINE_VERSION} is the only production engine.`,
    )
  }
}

export function migrationLockMeta() {
  return {
    canonical_engine_version: CANONICAL_ENGINE_VERSION,
    subscription_schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    migration_completed_setting: APP_SETTING_MIGRATION_COMPLETED,
    legacy_lock_setting: APP_SETTING_LEGACY_LOCK,
  }
}
