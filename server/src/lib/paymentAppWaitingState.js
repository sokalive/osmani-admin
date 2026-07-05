/**
 * App-visible payment / activation waiting states (backward-compatible additive fields).
 */
import { ACTIVATION_STATE } from './canonicalPaymentActivation.js'

export const APP_WAITING_STATE = Object.freeze({
  PAYMENT_PENDING: 'PAYMENT_PENDING',
  PROVIDER_CONFIRMED_ACTIVATING: 'PROVIDER_CONFIRMED_ACTIVATING',
  ACTIVE: 'ACTIVE',
  PHONE_CONFLICT: 'PHONE_CONFLICT',
  MOVED_TO_SIBLING_DEVICE: 'MOVED_TO_SIBLING_DEVICE',
  FAILED: 'FAILED',
  RETRYING: 'RETRYING',
  MANUAL_REVIEW_REQUIRED: 'MANUAL_REVIEW_REQUIRED',
})

function activationFromTxn(txn) {
  const raw = txn?.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  return raw.activation_result && typeof raw.activation_result === 'object' ? raw.activation_result : null
}

/**
 * Derive machine-readable waiting state for payment-status / sonicpesa status endpoints.
 */
export function deriveAppWaitingState({ txn, activation = null, subscriptionActive = null }) {
  const status = String(txn?.status ?? '').trim()
  const act = activation ?? activationFromTxn(txn)
  const activationState = String(act?.activation_state ?? '').trim()

  if (status === 'failed') {
    return {
      app_waiting_state: APP_WAITING_STATE.FAILED,
      activation_state: activationState || ACTIVATION_STATE.TERMINAL_REJECTED,
      entitlement_active: false,
      retryable: false,
    }
  }

  if (activationState === ACTIVATION_STATE.PHONE_CONFLICT || act?.phone_conflict) {
    return {
      app_waiting_state: APP_WAITING_STATE.PHONE_CONFLICT,
      activation_state: activationState,
      entitlement_active: act?.entitlement_active === true,
      retryable: false,
      user_action_required: true,
    }
  }

  if (activationState === ACTIVATION_STATE.MOVED_TO_SIBLING_DEVICE || act?.moved_to_sibling_device) {
    return {
      app_waiting_state: APP_WAITING_STATE.MOVED_TO_SIBLING_DEVICE,
      activation_state: activationState,
      entitlement_active: act?.entitlement_active === true,
      retryable: false,
      user_action_required: act?.user_action_required === true,
    }
  }

  if (subscriptionActive === true || activationState === ACTIVATION_STATE.ACTIVATED || activationState === ACTIVATION_STATE.ALREADY_APPLIED) {
    return {
      app_waiting_state: APP_WAITING_STATE.ACTIVE,
      activation_state: activationState || ACTIVATION_STATE.ACTIVATED,
      entitlement_active: true,
      retryable: false,
    }
  }

  if (activationState === ACTIVATION_STATE.RETRYABLE_DB_ERROR || act?.retryable) {
    return {
      app_waiting_state: APP_WAITING_STATE.RETRYING,
      activation_state: activationState,
      entitlement_active: false,
      retryable: true,
    }
  }

  if (status === 'completed') {
    return {
      app_waiting_state: APP_WAITING_STATE.PROVIDER_CONFIRMED_ACTIVATING,
      activation_state: activationState || ACTIVATION_STATE.PROVIDER_NOT_CONFIRMED,
      entitlement_active: false,
      retryable: true,
    }
  }

  return {
    app_waiting_state: APP_WAITING_STATE.PAYMENT_PENDING,
    activation_state: activationState || ACTIVATION_STATE.PROVIDER_NOT_CONFIRMED,
    entitlement_active: false,
    retryable: true,
  }
}
