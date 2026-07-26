/**
 * Canonical Validator — every subscription API response must agree with the canonical engine.
 * Detects inconsistency, logs it, and never exposes contradictory entitlement fields.
 * Does NOT invent paid access: inconsistent active claims are forced inactive / sanitized.
 */
import { getPool } from '../db/pool.js'
import {
  CANONICAL_ENGINE_VERSION,
  SUBSCRIPTION_SCHEMA_VERSION,
} from './subscriptionHardeningConstants.js'
import { computeRemainingCalendarDaysEat } from './subscriptionStacking.js'

function toMs(v) {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

async function recordValidatorEvent({
  deviceId = null,
  surface = 'unknown',
  code,
  message,
  details = {},
  rejected = false,
} = {}) {
  try {
    const pool = getPool()
    if (!pool) return
    await pool.query(
      `INSERT INTO subscription_canonical_validator_events
         (device_id, surface, code, message, details, rejected,
          canonical_engine_version, subscription_schema_version)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8)`,
      [
        deviceId ? String(deviceId).trim() : null,
        String(surface || 'unknown').slice(0, 120),
        String(code || 'INCONSISTENT').slice(0, 120),
        String(message || '').slice(0, 2000),
        JSON.stringify(details ?? {}),
        rejected === true,
        CANONICAL_ENGINE_VERSION,
        SUBSCRIPTION_SCHEMA_VERSION,
      ],
    )
  } catch (e) {
    console.error('[canonical-validator] record failed:', e?.message || e)
  }
}

function inactiveShell(pub, reason) {
  return {
    ...pub,
    active: false,
    status: pub.status === 'revoked' || pub.admin_revoked_at ? 'revoked' : String(pub.status || 'revoked'),
    remaining_seconds: 0,
    remainingSeconds: 0,
    remaining_hours: 0,
    remainingHours: 0,
    remaining_days: 0,
    remainingDays: 0,
    entitlement_remaining_days: 0,
    entitlementRemainingDays: 0,
    near_expiry: false,
    nearExpiry: false,
    canonical_validator: {
      ok: false,
      sanitized: true,
      reason,
      engine: CANONICAL_ENGINE_VERSION,
      schema: SUBSCRIPTION_SCHEMA_VERSION,
    },
  }
}

/**
 * Validate / sanitize a public subscription payload (verify, status, SSE, admin maps).
 * @returns {{ ok: boolean, payload: object, issues: string[] }}
 */
export function validateCanonicalSubscriptionPayload(pub, opts = {}) {
  const surface = String(opts.surface || 'subscription')
  const deviceId = opts.deviceId ?? pub?.device_id ?? pub?.deviceId ?? null
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now()
  const issues = []

  if (!pub || typeof pub !== 'object') {
    void recordValidatorEvent({
      deviceId,
      surface,
      code: 'NULL_PAYLOAD',
      message: 'Canonical Validator rejected null/invalid payload',
      rejected: true,
    })
    return {
      ok: false,
      payload: inactiveShell(
        {
          active: false,
          status: 'revoked',
          expiresAt: null,
          expires_at: null,
        },
        'null_payload',
      ),
      issues: ['null_payload'],
    }
  }

  let out = { ...pub }
  const status = String(out.status ?? '').toLowerCase()
  const expiresAt = out.expiresAt ?? out.expires_at ?? null
  const expiresMs = toMs(expiresAt)
  const adminRevoked = Boolean(out.admin_revoked_at || out.adminRevokedAt)
  const blocked = out.blocked === true || out.blocked_now === true
  let active = out.active === true

  if (adminRevoked || status === 'revoked') {
    if (active) {
      issues.push('active_while_revoked')
      active = false
    }
  }

  if (blocked && active) {
    issues.push('active_while_blocked')
    active = false
  }

  if (active && (expiresMs == null || expiresMs <= nowMs)) {
    issues.push('active_with_expired_or_missing_expiry')
    active = false
  }

  const canonicalRemaining =
    expiresMs != null && expiresMs > nowMs ? computeRemainingCalendarDaysEat(expiresMs, nowMs) : 0

  const claimedDays = Number(out.remaining_days ?? out.remainingDays ?? out.entitlement_remaining_days ?? 0)
  if (Number.isFinite(claimedDays) && claimedDays < 0) {
    issues.push('negative_remaining_days')
  }

  if (active && Number.isFinite(claimedDays) && Math.abs(claimedDays - canonicalRemaining) > 1) {
    issues.push('remaining_days_mismatch')
  }

  // Plan duration vs remaining: flag absurd over-credit exposure (do not invent stack).
  const planDays = Number(
    out.plan_duration_days ?? out.planDurationDays ?? out.durationDays ?? out.duration ?? NaN,
  )
  if (
    active &&
    Number.isFinite(planDays) &&
    planDays > 0 &&
    canonicalRemaining > planDays + 2 &&
    out.is_stacked_entitlement !== true &&
    out.isStackedEntitlement !== true
  ) {
    // Historical legitimate stacks may still exist; mark inconsistency for audit but do not
    // auto-revoke paid users. Surface remaining from canonical calendar only.
    issues.push('remaining_exceeds_plan_without_stack_flag')
  }

  out.active = active
  out.expiresAt = expiresMs != null ? new Date(expiresMs).toISOString() : expiresAt
  out.expires_at = out.expiresAt
  out.remaining_days = active ? canonicalRemaining : 0
  out.remainingDays = out.remaining_days
  out.entitlement_remaining_days = out.remaining_days
  out.entitlementRemainingDays = out.remaining_days

  if (!active) {
    out.remaining_seconds = 0
    out.remainingSeconds = 0
    out.remaining_hours = 0
    out.remainingHours = 0
    out.near_expiry = false
    out.nearExpiry = false
  } else if (expiresMs != null) {
    const remSec = Math.max(0, Math.floor((expiresMs - nowMs) / 1000))
    out.remaining_seconds = remSec
    out.remainingSeconds = remSec
    out.remaining_hours = Math.floor(remSec / 3600)
    out.remainingHours = out.remaining_hours
  }

  out.canonical_engine_version = CANONICAL_ENGINE_VERSION
  out.subscription_schema_version = SUBSCRIPTION_SCHEMA_VERSION
  out.canonical_validator = {
    ok: issues.length === 0,
    sanitized: issues.length > 0,
    issues: issues.length ? issues : undefined,
    engine: CANONICAL_ENGINE_VERSION,
    schema: SUBSCRIPTION_SCHEMA_VERSION,
  }

  if (issues.length) {
    void recordValidatorEvent({
      deviceId,
      surface,
      code: issues[0],
      message: `Canonical Validator sanitized inconsistent payload: ${issues.join(',')}`,
      details: { issues, active_before: pub.active === true, active_after: active },
      rejected: issues.includes('active_while_revoked') || issues.includes('active_with_expired_or_missing_expiry'),
    })
    console.warn('[canonical-validator]', surface, mask(deviceId), issues.join(','))
  }

  return { ok: issues.length === 0, payload: out, issues }
}

function mask(id) {
  const s = String(id ?? '').trim()
  if (!s) return null
  return s.length <= 10 ? `${s.slice(0, 4)}…` : `${s.slice(0, 8)}…`
}

/**
 * Wrap normalizeVerifyResponse output.
 */
export function validateVerifyResponse(pub, opts = {}) {
  return validateCanonicalSubscriptionPayload(pub, { ...opts, surface: opts.surface || 'verify' })
}
