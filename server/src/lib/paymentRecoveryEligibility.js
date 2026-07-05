/**
 * Payment order recovery eligibility — classify before any mutation.
 * Recovery target is always the trusted originating device on the order row.
 */
import {
  deviceSubscriptionOrderAlreadyApplied,
  getPlanRowByIdAny,
} from '../billingStore.js'
import { isIntentionalMigrationRevokedDevice } from './transferRevocationGuard.js'

export const RECOVERY_CLASS = Object.freeze({
  ALREADY_ACTIVE: 'ALREADY_ACTIVE',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  ALREADY_RECOVERED: 'ALREADY_RECOVERED',
  RECOVERY_REJECTED: 'RECOVERY_REJECTED',
  INTERNAL_COMPLETED_ACTIVATION_GAP: 'INTERNAL_COMPLETED_ACTIVATION_GAP',
  PROVIDER_PENDING: 'PROVIDER_PENDING',
  PROVIDER_FAILED: 'PROVIDER_FAILED',
  PROVIDER_LOOKUP_ERROR: 'PROVIDER_LOOKUP_ERROR',
  EXPLICIT_TRANSFER_CASE: 'EXPLICIT_TRANSFER_CASE',
  PLAN_MISMATCH: 'PLAN_MISMATCH',
  UNKNOWN_ORDER: 'UNKNOWN_ORDER',
  MANUAL_OVERRIDE_REQUIRED: 'MANUAL_OVERRIDE_REQUIRED',
  NO_ACTION_REQUIRED: 'NO_ACTION_REQUIRED',
})

export const RECOVERY_CLASS_LABEL = Object.freeze({
  ALREADY_ACTIVE: 'Already Active',
  ALREADY_APPLIED: 'Already Applied',
  ALREADY_RECOVERED: 'Manually Recovered',
  RECOVERY_REJECTED: 'Recovery Rejected',
  INTERNAL_COMPLETED_ACTIVATION_GAP: 'Internal Activation Gap',
  PROVIDER_PENDING: 'Pending at Provider',
  PROVIDER_FAILED: 'Failed at Provider',
  PROVIDER_LOOKUP_ERROR: 'Provider Lookup Error',
  EXPLICIT_TRANSFER_CASE: 'Explicit Transfer Case',
  PLAN_MISMATCH: 'Plan Missing',
  UNKNOWN_ORDER: 'Unknown Order',
  MANUAL_OVERRIDE_REQUIRED: 'Owner Override Required',
  NO_ACTION_REQUIRED: 'No Action Required',
})

function resolveOriginatingDeviceId(txn) {
  let deviceId = String(txn?.device_id ?? '').trim()
  const raw = txn?.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  if (!deviceId) deviceId = String(raw.device_id ?? '').trim()
  return deviceId
}

/**
 * @param {object} txn — transactions row
 * @param {object|null} subRow — device_subscriptions row for originating device (optional)
 */
export async function classifyPaymentRecoveryEligibility(txn, subRow = null, client = null) {
  if (!txn) {
    return {
      class: RECOVERY_CLASS.UNKNOWN_ORDER,
      label: RECOVERY_CLASS_LABEL.UNKNOWN_ORDER,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      deviceId: null,
      orderId: null,
      message: 'Order not found',
    }
  }

  const orderId = String(txn.order_id ?? '').trim()
  const recoveryState = String(txn.recovery_state ?? '').trim().toUpperCase()
  const txnStatus = String(txn.status ?? 'pending').trim().toLowerCase()
  const deviceId = resolveOriginatingDeviceId(txn)
  const planId = txn.plan_id

  const base = {
    orderId,
    deviceId,
    txnStatus,
    recoveryState,
    planId,
    provider: txn.raw_payload?.payment_provider ?? null,
  }

  if (orderId.startsWith('manual_grant:')) {
    return {
      ...base,
      class: RECOVERY_CLASS.UNKNOWN_ORDER,
      label: RECOVERY_CLASS_LABEL.UNKNOWN_ORDER,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Manual grant orders are not payment recovery targets',
    }
  }

  if (recoveryState === 'MANUALLY_APPROVED') {
    return {
      ...base,
      class: RECOVERY_CLASS.ALREADY_RECOVERED,
      label: RECOVERY_CLASS_LABEL.ALREADY_RECOVERED,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Order already manually recovered',
    }
  }

  if (recoveryState === 'RECOVERY_REJECTED') {
    return {
      ...base,
      class: RECOVERY_CLASS.RECOVERY_REJECTED,
      label: RECOVERY_CLASS_LABEL.RECOVERY_REJECTED,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Recovery was rejected for this order',
    }
  }

  if (!deviceId) {
    return {
      ...base,
      class: RECOVERY_CLASS.UNKNOWN_ORDER,
      label: RECOVERY_CLASS_LABEL.UNKNOWN_ORDER,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Originating device_id missing on order',
    }
  }

  if (!planId) {
    return {
      ...base,
      class: RECOVERY_CLASS.PLAN_MISMATCH,
      label: RECOVERY_CLASS_LABEL.PLAN_MISMATCH,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Plan missing on order',
    }
  }

  const plan = await getPlanRowByIdAny(planId)
  if (!plan) {
    return {
      ...base,
      class: RECOVERY_CLASS.PLAN_MISMATCH,
      label: RECOVERY_CLASS_LABEL.PLAN_MISMATCH,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Plan not found',
    }
  }

  if (await isIntentionalMigrationRevokedDevice(deviceId)) {
    return {
      ...base,
      class: RECOVERY_CLASS.EXPLICIT_TRANSFER_CASE,
      label: RECOVERY_CLASS_LABEL.EXPLICIT_TRANSFER_CASE,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Source device was revoked by explicit transfer (moved:*)',
    }
  }

  if (await deviceSubscriptionOrderAlreadyApplied(orderId, client)) {
    return {
      ...base,
      class: RECOVERY_CLASS.ALREADY_APPLIED,
      label: RECOVERY_CLASS_LABEL.ALREADY_APPLIED,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Entitlement for this order_id already applied',
    }
  }

  const sub = subRow ?? null
  const subActive =
    sub &&
    String(sub.status ?? 'active').toLowerCase() === 'active' &&
    sub.expires_at &&
    new Date(sub.expires_at).getTime() > Date.now() &&
    String(sub.transaction_id ?? '') === orderId

  if (subActive) {
    return {
      ...base,
      class: RECOVERY_CLASS.ALREADY_ACTIVE,
      label: RECOVERY_CLASS_LABEL.ALREADY_ACTIVE,
      allowed: false,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: false,
      message: 'Originating device already active for this order',
    }
  }

  if (txnStatus === 'completed') {
    return {
      ...base,
      class: RECOVERY_CLASS.INTERNAL_COMPLETED_ACTIVATION_GAP,
      label: RECOVERY_CLASS_LABEL.INTERNAL_COMPLETED_ACTIVATION_GAP,
      allowed: true,
      requiresOwnerOverride: false,
      canUseCanonicalActivation: true,
      message: 'Payment completed — repair activation via canonical engine',
    }
  }

  if (txnStatus === 'failed') {
    return {
      ...base,
      class: RECOVERY_CLASS.PROVIDER_FAILED,
      label: RECOVERY_CLASS_LABEL.PROVIDER_FAILED,
      allowed: false,
      requiresOwnerOverride: true,
      canUseCanonicalActivation: false,
      message: 'Provider failed — owner override required to grant manually',
    }
  }

  if (txnStatus === 'pending') {
    const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (raw.provider_lookup_error === true || raw.order_status_poll?.error) {
      return {
        ...base,
        class: RECOVERY_CLASS.PROVIDER_LOOKUP_ERROR,
        label: RECOVERY_CLASS_LABEL.PROVIDER_LOOKUP_ERROR,
        allowed: false,
        requiresOwnerOverride: true,
        canUseCanonicalActivation: false,
        message: 'Provider lookup error — poll reconcile or owner override',
      }
    }
    return {
      ...base,
      class: RECOVERY_CLASS.PROVIDER_PENDING,
      label: RECOVERY_CLASS_LABEL.PROVIDER_PENDING,
      allowed: false,
      requiresOwnerOverride: true,
      canUseCanonicalActivation: false,
      message: 'Provider pending — reconcile first; owner override only if independently verified',
    }
  }

  return {
    ...base,
    class: RECOVERY_CLASS.UNKNOWN_ORDER,
    label: RECOVERY_CLASS_LABEL.UNKNOWN_ORDER,
    allowed: false,
    requiresOwnerOverride: true,
    canUseCanonicalActivation: false,
    message: `Unexpected transaction status: ${txnStatus}`,
  }
}
