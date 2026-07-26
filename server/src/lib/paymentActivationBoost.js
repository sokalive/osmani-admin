import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import * as billing from '../billingStore.js'
import { notifySubscriptionActivatedFromAct } from './subscriptionActivationNotify.js'

/**
 * Aggressive post-checkout polls — SonicPesa webhooks are often absent in production,
 * so activation must not depend on the durable queue alone.
 *
 * Dense first ~30s (provider often confirms within seconds of M-Pesa toast), then
 * coarser polls out to ~3 minutes. The durable reconcile queue covers beyond that.
 * Never wait 45–60s between early polls — that was the ~1 minute "Inaanzisha" lag.
 */
function parsePollDelaysMs() {
  const raw = String(
    process.env.PAYMENT_ACTIVATION_POLL_MS ||
      '0,400,900,1600,2500,4000,6000,9000,13000,18000,25000,35000,50000,75000,110000,160000',
  )
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
  return parsed.length > 0
    ? parsed
    : [0, 400, 900, 1600, 2500, 4000, 6000, 9000, 13000, 18000, 25000, 35000, 50000, 75000, 110000, 160000]
}

const inFlightOrders = new Map()

async function runActivationBoostTick(oid, did) {
  if (inFlightOrders.has(oid)) return inFlightOrders.get(oid)
  const p = (async () => {
    try {
      const rec = await reconcileOrderWithZenoPay(oid, { forcePoll: true })
      const fin = await billing.tryFinalizeActivationForDevice(did)
      if (rec?.activation?.entitlement_active || rec?.activation?.activated) {
        notifySubscriptionActivatedFromAct(rec.activation, oid)
      } else if (fin?.entitlement_active || fin?.activated) {
        notifySubscriptionActivatedFromAct(
          {
            skipped: fin.skipped === true,
            activated: fin.activated === true,
            entitlement_active: fin.entitlement_active === true || fin.activated === true,
            deviceId: fin.deviceId,
            orderId: fin.orderId,
          },
          fin.orderId ?? oid,
        )
      }
      return rec
    } finally {
      inFlightOrders.delete(oid)
    }
  })()
  inFlightOrders.set(oid, p)
  return p
}

/**
 * Poll provider + finalize activation after payment initiation (webhook may lag or be absent).
 * First tick runs immediately; follow-ups are backoff polls. Fire-and-forget; idempotent.
 */
export function schedulePostPaymentActivationPolls(orderId, deviceId) {
  const oid = String(orderId ?? '').trim()
  const did = String(deviceId ?? '').trim()
  if (!oid || !did) return

  for (const delayMs of parsePollDelaysMs()) {
    const run = () => {
      void runActivationBoostTick(oid, did).catch((e) => {
        console.warn('[payment-activation-boost] poll failed:', oid, e?.message || e)
      })
    }
    if (delayMs <= 0) run()
    else setTimeout(run, delayMs)
  }
}
