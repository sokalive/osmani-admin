/**
 * Realtime fan-out after admin manual grant activation.
 * Mirrors deletion path cache bust + adds manual_gift SSE hint for connected clients.
 */
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { liveSyncBus } from './liveSyncBus.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { clearVerifyAccessInflightForDevice } from './verifyAccessSingleflight.js'

export function buildManualGiftSsePayload({ grantId, nonce, durationDays }) {
  return {
    showPopup: true,
    nonce: String(nonce),
    grantId: Number(grantId),
    durationDays: Number(durationDays),
    title: 'Hongera!',
    body:
      'Umepokea kifurushi cha ofa kutoka kwa muhudumu wetu. Sasa unaweza kutazama channel zote kuanzia sasa.',
    ctaLabel: 'ASANTE',
  }
}

/** @param {{ grantId: number, nonce: string, durationDays: number, orderId?: string|null }} meta */
export function publishManualGrantActivationRealtime(deviceId, meta) {
  const did = String(deviceId ?? '').trim()
  if (!did || !meta?.grantId) return false

  const orderId = meta.orderId ?? `manual_grant:${meta.grantId}`
  const manualGift = buildManualGiftSsePayload(meta)

  invalidateSubscriptionAccessCache(did)
  clearVerifyAccessInflightForDevice(did)
  deviceSubscriptionBus.emit('manual_gift', { deviceId: did, manualGift })
  deviceSubscriptionBus.emit('update', { deviceId: did, reason: 'manual_grant_activated' })
  liveSyncBus.publish('analytics.subscription_updated', {
    topics: ['analytics'],
    deviceId: did,
    orderId,
    manualGift,
  })
  return true
}
