/**
 * Push subscription activation to verify cache, in-process SSE, and admin realtime relay.
 * Synchronous — safe to call immediately after DB activation.
 */
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { liveSyncBus } from './liveSyncBus.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'

export function notifySubscriptionActivated(deviceId, orderId = null) {
  const did = String(deviceId ?? '').trim()
  if (!did) return false
  invalidateSubscriptionAccessCache(did)
  deviceSubscriptionBus.emit('update', { deviceId: did, reason: 'subscription_activated' })
  liveSyncBus.publish('analytics.subscription_updated', {
    topics: ['analytics'],
    deviceId: did,
    orderId: orderId != null ? String(orderId) : null,
    reason: 'subscription_activated',
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
  return notifySubscriptionActivated(act.deviceId, orderId ?? act.orderId ?? null)
}
