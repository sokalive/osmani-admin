/**
 * Push subscription activation to verify cache, in-process SSE, and admin realtime relay.
 * Synchronous — safe to call immediately after DB activation.
 */
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { liveSyncBus } from './liveSyncBus.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'

/** Congratulations payload pushed over SSE right after a payment activates. */
export function buildPaymentCongratsSsePayload({ orderId = null } = {}) {
  return {
    showPopup: true,
    orderId: orderId != null ? String(orderId) : null,
    title: 'Hongera!',
    body: 'Malipo yako yamekamilika na kifurushi chako kimewashwa. Karibu utazame channel zote.',
    ctaLabel: 'ASANTE',
    reason: 'payment_activated',
  }
}

export function notifySubscriptionActivated(deviceId, orderId = null, opts = {}) {
  const did = String(deviceId ?? '').trim()
  if (!did) return false
  invalidateSubscriptionAccessCache(did)
  // Congratulations only on a FRESH activation — re-notifies (reconcile polls hitting
  // ALREADY_APPLIED) must not replay the popup.
  const paymentCongrats = opts.congrats === true ? buildPaymentCongratsSsePayload({ orderId }) : null
  deviceSubscriptionBus.emit('update', { deviceId: did, reason: 'subscription_activated' })
  if (paymentCongrats) {
    deviceSubscriptionBus.emit('payment_congrats', { deviceId: did, paymentCongrats })
  }
  liveSyncBus.publish('analytics.subscription_updated', {
    topics: ['analytics'],
    deviceId: did,
    orderId: orderId != null ? String(orderId) : null,
    reason: 'subscription_activated',
    ...(paymentCongrats ? { paymentCongrats } : {}),
  })
  return true
}

/**
 * Push when paying-device entitlement is active — including ALREADY_APPLIED so a losing
 * concurrent path still invalidates verify cache and notifies SSE clients.
 * @param {{
 *   skipped?: boolean,
 *   activated?: boolean,
 *   entitlement_active?: boolean,
 *   moved_to_sibling_device?: boolean,
 *   phone_conflict?: boolean,
 *   activation_state?: string|null,
 *   deviceId?: string|null,
 *   orderId?: string|null,
 * }} act
 */
export function notifySubscriptionActivatedFromAct(act, orderId = null) {
  if (!act?.deviceId) return false
  if (act.moved_to_sibling_device === true || act.phone_conflict === true) return false
  const state = String(act.activation_state ?? '').trim()
  const ok =
    act.activated === true ||
    act.entitlement_active === true ||
    state === 'ACTIVATED' ||
    state === 'ALREADY_APPLIED'
  if (!ok) return false
  const fresh = act.activated === true && state !== 'ALREADY_APPLIED'
  return notifySubscriptionActivated(act.deviceId, orderId ?? act.orderId ?? null, {
    congrats: fresh,
  })
}
