import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'

const DEFAULT_DELAYS_MS = String(process.env.PAYMENT_ACTIVATION_POLL_MS || '2000,5000,12000,25000')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

/**
 * Poll provider + finalize activation after payment initiation (webhook may lag).
 * Fire-and-forget; idempotent reconcile paths.
 */
export function schedulePostPaymentActivationPolls(orderId, deviceId) {
  const oid = String(orderId ?? '').trim()
  const did = String(deviceId ?? '').trim()
  if (!oid || !did) return

  for (const delayMs of DEFAULT_DELAYS_MS) {
    setTimeout(() => {
      void (async () => {
        try {
          const rec = await reconcileOrderWithZenoPay(oid, { forcePoll: true })
          const fin = await billing.tryFinalizeActivationForDevice(did)
          if (rec?.activation?.activated || fin?.activated) {
            invalidateSubscriptionAccessCache(did)
            deviceSubscriptionBus.emit('update', { deviceId: did })
          }
        } catch (e) {
          console.warn('[payment-activation-boost] poll failed:', oid, e?.message || e)
        }
      })()
    }, delayMs)
  }
}
