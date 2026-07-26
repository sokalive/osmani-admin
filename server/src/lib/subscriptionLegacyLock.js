/**
 * Legacy Lock — obsolete subscription calculators / repair / replay / builders must not run.
 */
import {
  CANONICAL_ENGINE_VERSION,
} from './subscriptionHardeningConstants.js'
import {
  assertLegacyWritePathBlocked,
  assertHistoricalMigrationWritesBlocked,
  isLegacySubscriptionLockEnabled,
} from './subscriptionMigrationLock.js'

/** Named obsolete surfaces — any live mutate call must be blocked. */
export const LEGACY_PATHS = Object.freeze({
  EXPIRY_OVERCREDIT_REPAIR: 'repairSubscriptionExpiryOverCredits',
  HISTORICAL_NORMALIZATION_APPLY: 'applyHistoricalSubscriptionNormalization',
  FALSE_EXPIRED_REPAIR: 'repairFalseExpiredSubscriptions',
  WRONG_DIRECTION_REPAIR: 'repairWrongDirectionMigrations',
  LEGACY_STACK_REPLAY_WRITE: 'legacyStackReplayWrite',
  LEGACY_EXPIRY_BUILDER: 'legacyExpiryBuilder',
})

export class LegacyLockError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'LegacyLockError'
    this.code = code
  }
}

/**
 * Synchronous fail-closed for in-process dead code that should never be imported for writes.
 * Prefer async assertLegacyWritePathBlocked for DB-backed lock.
 */
export function refuseLegacyExecution(pathName, detail = '') {
  const msg = `Legacy Lock refused execution of ${pathName}. Canonical engine ${CANONICAL_ENGINE_VERSION} only.${detail ? ` ${detail}` : ''}`
  console.error('[legacy-lock]', msg)
  throw new LegacyLockError('LEGACY_EXECUTION_REFUSED', msg)
}

export async function guardLegacyRepairWrite(pathName = LEGACY_PATHS.EXPIRY_OVERCREDIT_REPAIR) {
  await assertLegacyWritePathBlocked(pathName)
}

export async function guardHistoricalNormalizationApply() {
  await assertHistoricalMigrationWritesBlocked(LEGACY_PATHS.HISTORICAL_NORMALIZATION_APPLY)
}

export async function legacyLockStatus() {
  return {
    enabled: await isLegacySubscriptionLockEnabled(),
    canonical_engine_version: CANONICAL_ENGINE_VERSION,
    blocked_paths: Object.values(LEGACY_PATHS),
  }
}
