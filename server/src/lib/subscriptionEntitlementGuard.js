/**
 * Permanent Entitlement Guard.
 * Every activation / payment / renewal / stack / manual / migration write must pass.
 * Entitlement expiry is validated against legitimate plan duration + canonical midnight-EAT policy.
 * Invalid writes are rejected and recorded — nothing invalid may enter production.
 */
import { getPool } from '../db/pool.js'
import {
  CANONICAL_ENGINE_VERSION,
  ENTITLEMENT_GUARD_SOURCES,
  EXPIRY_MS_TOLERANCE,
  MAX_SINGLE_PLAN_DURATION_DAYS,
  MIN_SINGLE_PLAN_DURATION_DAYS,
  NEW_PURCHASE_REMAINING_DAYS_GRACE,
  SUBSCRIPTION_SCHEMA_VERSION,
} from './subscriptionHardeningConstants.js'
import {
  computeMidnightEatExpiryIso,
  computeRemainingCalendarDaysEat,
  computeStackedExpiryIso,
} from './subscriptionStacking.js'

export class EntitlementGuardError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'EntitlementGuardError'
    this.code = code
    this.details = details
    this.reject = true
  }
}

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function toMs(v) {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

function maskId(id) {
  const s = String(id ?? '').trim()
  if (!s) return null
  if (s.length <= 10) return `${s.slice(0, 4)}…`
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

/**
 * Persist a guard rejection (best-effort; never throws into caller path after reject decision).
 */
export async function recordEntitlementGuardRejection({
  deviceId = null,
  orderId = null,
  source = ENTITLEMENT_GUARD_SOURCES.OTHER,
  code,
  message,
  details = {},
  proposedExpiresAt = null,
  durationDays = null,
} = {}) {
  try {
    const pool = getPool()
    if (!pool) return
    await pool.query(
      `INSERT INTO subscription_entitlement_guard_rejections
         (device_id, order_id, source, code, message, details, proposed_expires_at, duration_days,
          canonical_engine_version, subscription_schema_version)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::timestamptz, $8, $9, $10)`,
      [
        deviceId ? String(deviceId).trim() : null,
        orderId ? String(orderId).trim() : null,
        String(source || ENTITLEMENT_GUARD_SOURCES.OTHER),
        String(code || 'REJECTED'),
        String(message || 'entitlement rejected').slice(0, 2000),
        JSON.stringify(details ?? {}),
        proposedExpiresAt ? new Date(proposedExpiresAt).toISOString() : null,
        durationDays != null ? Number(durationDays) : null,
        CANONICAL_ENGINE_VERSION,
        SUBSCRIPTION_SCHEMA_VERSION,
      ],
    )
  } catch (e) {
    console.error('[entitlement-guard] failed to record rejection:', e?.message || e)
  }
}

async function reject(opts) {
  await recordEntitlementGuardRejection(opts)
  throw new EntitlementGuardError(opts.code, opts.message, opts.details)
}

/**
 * Validate a proposed entitlement write.
 * @param {{
 *   deviceId: string,
 *   orderId?: string|null,
 *   expiresAt: string|Date,
 *   durationDays?: number|null,
 *   previousExpiresAt?: string|Date|null,
 *   source?: string,
 *   allowAbsoluteCustom?: boolean,
 *   startedAt?: string|Date|null,
 *   nowMs?: number,
 * }} input
 */
export async function assertWritableEntitlement(input = {}) {
  const deviceId = String(input.deviceId ?? '').trim()
  const orderId = input.orderId != null ? String(input.orderId).trim() : null
  const source = String(input.source || ENTITLEMENT_GUARD_SOURCES.OTHER)
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now()
  const expiresAtMs = toMs(input.expiresAt)
  const durationRaw = input.durationDays
  const durationDays =
    durationRaw == null || durationRaw === ''
      ? null
      : Math.trunc(Number(durationRaw))

  const baseLog = {
    deviceId,
    orderId,
    source,
    proposedExpiresAt: input.expiresAt,
    durationDays,
  }

  if (!deviceId) {
    await reject({
      ...baseLog,
      code: 'MISSING_DEVICE_ID',
      message: 'Entitlement Guard rejected write: deviceId required',
      details: {},
    })
  }

  if (expiresAtMs == null) {
    await reject({
      ...baseLog,
      code: 'INVALID_EXPIRY',
      message: 'Entitlement Guard rejected write: expiresAt is invalid',
      details: { expiresAt: input.expiresAt },
    })
  }

  if (expiresAtMs <= nowMs) {
    await reject({
      ...baseLog,
      code: 'EXPIRED_OR_NON_FUTURE',
      message: 'Entitlement Guard rejected write: expiresAt must be in the future',
      details: {
        expiresAt: new Date(expiresAtMs).toISOString(),
        now: new Date(nowMs).toISOString(),
      },
    })
  }

  const remainingDays = computeRemainingCalendarDaysEat(expiresAtMs, nowMs)
  if (remainingDays < 0) {
    await reject({
      ...baseLog,
      code: 'NEGATIVE_REMAINING_DAYS',
      message: 'Entitlement Guard rejected write: negative remaining days',
      details: { remainingDays },
    })
  }

  if (durationDays != null) {
    if (
      !Number.isFinite(durationDays) ||
      durationDays < MIN_SINGLE_PLAN_DURATION_DAYS ||
      durationDays > MAX_SINGLE_PLAN_DURATION_DAYS
    ) {
      await reject({
        ...baseLog,
        code: 'IMPOSSIBLE_DURATION',
        message: `Entitlement Guard rejected write: durationDays out of bounds (${MIN_SINGLE_PLAN_DURATION_DAYS}–${MAX_SINGLE_PLAN_DURATION_DAYS})`,
        details: { durationDays },
      })
    }
  }

  // Absolute custom admin grants: still bound remaining days to max plan + grace window
  // unless explicitly marked allowAbsoluteCustom with a sane upper cap (2 years).
  if (input.allowAbsoluteCustom === true) {
    const maxCustomDays = MAX_SINGLE_PLAN_DURATION_DAYS * 2
    if (remainingDays > maxCustomDays + NEW_PURCHASE_REMAINING_DAYS_GRACE) {
      await reject({
        ...baseLog,
        code: 'OVER_CREDIT',
        message: 'Entitlement Guard rejected custom grant: remaining days exceed absolute cap',
        details: { remainingDays, maxCustomDays },
      })
    }
    if (input.startedAt != null) {
      const startMs = toMs(input.startedAt)
      if (startMs == null) {
        await reject({
          ...baseLog,
          code: 'INVALID_STARTED_AT',
          message: 'Entitlement Guard rejected write: startedAt invalid',
          details: {},
        })
      }
      if (expiresAtMs <= startMs) {
        await reject({
          ...baseLog,
          code: 'IMPOSSIBLE_SUBSCRIPTION_WINDOW',
          message: 'Entitlement Guard rejected write: expiresAt must be after startedAt',
          details: {
            startedAt: new Date(startMs).toISOString(),
            expiresAt: new Date(expiresAtMs).toISOString(),
          },
        })
      }
    }
    return {
      ok: true,
      policy: 'absolute_custom',
      remainingDays,
      expiresAt: new Date(expiresAtMs).toISOString(),
      canonical_engine_version: CANONICAL_ENGINE_VERSION,
      subscription_schema_version: SUBSCRIPTION_SCHEMA_VERSION,
    }
  }

  // Payment / standard path: must match canonical midnight-EAT or preserve-existing-active.
  const daysForCompute = durationDays ?? remainingDays
  if (daysForCompute == null || daysForCompute < 1) {
    await reject({
      ...baseLog,
      code: 'MISSING_DURATION',
      message: 'Entitlement Guard rejected write: durationDays required for non-custom entitlement',
      details: {},
    })
  }

  const stack = computeStackedExpiryIso(input.previousExpiresAt ?? null, daysForCompute, nowMs)
  const expectedMs = toMs(stack.expiresAt)
  if (expectedMs == null) {
    await reject({
      ...baseLog,
      code: 'CANONICAL_COMPUTE_FAILED',
      message: 'Entitlement Guard rejected write: canonical expiry compute failed',
      details: {},
    })
  }

  // Unsupported stacking: new purchases must not invent stacked multi-plan extensions.
  if (stack.stacked === true) {
    await reject({
      ...baseLog,
      code: 'UNSUPPORTED_STACKING',
      message: 'Entitlement Guard rejected write: stacking is permanently disabled',
      details: { stack },
    })
  }

  const delta = Math.abs(expiresAtMs - expectedMs)
  if (delta > EXPIRY_MS_TOLERANCE) {
    // Allow preserve-existing when proposed equals previous future expiry.
    const prevMs = toMs(input.previousExpiresAt)
    const preserving =
      prevMs != null &&
      prevMs > nowMs &&
      Math.abs(expiresAtMs - prevMs) <= EXPIRY_MS_TOLERANCE
    if (!preserving) {
      await reject({
        ...baseLog,
        code: 'OVER_CREDIT',
        message:
          'Entitlement Guard rejected write: proposed expiry does not match canonical midnight-EAT (or preserve-existing) policy',
        details: {
          proposed: new Date(expiresAtMs).toISOString(),
          expected: new Date(expectedMs).toISOString(),
          delta_ms: delta,
          remainingDays,
          expiry_policy: stack.expiry_policy,
          device_masked: maskId(deviceId),
        },
      })
    }
  }

  // Hard over-credit ceiling for brand-new entitlements (no previous future).
  const prevMs = toMs(input.previousExpiresAt)
  const previousFuture = prevMs != null && prevMs > nowMs
  if (!previousFuture && durationDays != null) {
    const maxAllowedRemaining = durationDays + NEW_PURCHASE_REMAINING_DAYS_GRACE
    if (remainingDays > maxAllowedRemaining) {
      await reject({
        ...baseLog,
        code: 'OVER_CREDIT',
        message: 'Entitlement Guard rejected write: remaining days exceed plan duration + grace',
        details: { remainingDays, maxAllowedRemaining, durationDays },
      })
    }
    // Also compare against pure midnight compute without preserve.
    const pure = computeMidnightEatExpiryIso(durationDays, nowMs)
    const pureMs = toMs(pure)
    if (pureMs != null && expiresAtMs > pureMs + EXPIRY_MS_TOLERANCE) {
      await reject({
        ...baseLog,
        code: 'OVER_CREDIT',
        message: 'Entitlement Guard rejected write: expiry beyond midnight-EAT plan window',
        details: {
          proposed: new Date(expiresAtMs).toISOString(),
          midnight_eat: pure,
        },
      })
    }
  }

  return {
    ok: true,
    policy: stack.expiry_policy,
    remainingDays,
    expiresAt: new Date(expiresAtMs).toISOString(),
    stacked: false,
    stacking_disabled: true,
    canonical_engine_version: CANONICAL_ENGINE_VERSION,
    subscription_schema_version: SUBSCRIPTION_SCHEMA_VERSION,
  }
}

/**
 * Convenience: validate then return ISO expiry string (throws on reject).
 */
export async function guardExpiresAtOrThrow(input) {
  const result = await assertWritableEntitlement(input)
  return result.expiresAt
}

export { ENTITLEMENT_GUARD_SOURCES }
