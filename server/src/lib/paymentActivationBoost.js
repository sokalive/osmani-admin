import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import * as billing from '../billingStore.js'
import { notifySubscriptionActivatedFromAct } from './subscriptionActivationNotify.js'

function parsePollDelaysMs() {
  const raw = String(process.env.PAYMENT_ACTIVATION_POLL_MS || '0,750,2000,5000,10000,20000,30000')
  const parsed = raw
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n >= 0)
  return parsed.length > 0 ? parsed : [0, 750, 2000, 5000, 10000, 20000, 30000]
}

const inFlightOrders = new Map()

async function runActivationBoostTick(oid, did) {
  if (inFlightOrders.has(oid)) return inFlightOrders.get(oid)
  const p = (async () => {
    try {
      const rec = await reconcileOrderWithZenoPay(oid, { forcePoll: true })
      const fin = await billing.tryFinalizeActivationForDevice(did)
      if (rec?.activation?.activated) {
        notifySubscriptionActivatedFromAct(rec.activation, oid)
      } else if (fin?.activated) {
        notifySubscriptionActivatedFromAct(
          { skipped: false, deviceId: fin.deviceId, orderId: fin.orderId },
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
 * Poll provider + finalize activation after payment initiation (webhook may lag).
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
