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

/** @param {{ skipped?: boolean, deviceId?: string|null, orderId?: string|null }} act */
export function notifySubscriptionActivatedFromAct(act, orderId = null) {
  if (!act || act.skipped || !act.deviceId) return false
  return notifySubscriptionActivated(act.deviceId, orderId ?? act.orderId ?? null)
}
