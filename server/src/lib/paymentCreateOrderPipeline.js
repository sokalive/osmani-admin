/**
 * Fast create-order HTTP response: persist pending txn, return 201 immediately,
 * initiate provider collection in background (avoids client timeout while USSD is sent).
 */
import * as billing from '../billingStore.js'
import { liveSyncBus } from './liveSyncBus.js'
import { schedulePostPaymentActivationPolls } from './paymentActivationBoost.js'
import { enqueueSonicpesaPaymentReconciliation } from './sonicpesaPaymentReconciliationQueue.js'

const LOG = '[create-order-pipeline]'

/**
 * @param {import('express').Response} res
 * @param {object} body
 * @param {{ orderId?: string, deviceId?: string }} [watch]
 */
export function respondCreateOrderAccepted(res, body, watch = {}) {
  const orderId = String(watch.orderId ?? body.orderId ?? '').trim()
  const deviceId = String(watch.deviceId ?? body.deviceId ?? '').trim()
  if (orderId && deviceId) {
    schedulePostPaymentActivationPolls(orderId, deviceId)
    void enqueueSonicpesaPaymentReconciliation(orderId, deviceId, { priority: 2 }).catch((e) => {
      console.warn('[create-order-pipeline] reconcile enqueue failed:', orderId, e?.message || e)
    })
  }
  res.status(201).json({
    provider_initiation: 'pending',
    ...body,
  })
}

/**
 * Fire-and-forget provider POST; updates transaction + analytics when complete.
 * @param {{
 *   provider: string,
 *   orderId: string,
 *   deviceId: string,
 *   prevPayload: object,
 *   cred: object,
 *   phone: string,
 *   amount: number,
 *   initiate: (cred: object, args: { phone: string, amount: number, orderId: string, currency?: string }) => Promise<object>,
 *   onProviderResult?: (result: object) => Promise<void>,
 *   resolveExternalId?: (result: object) => string | null,
 *   providerBodyKey?: string,
 * }} opts
 */
export function runProviderCreateOrderInBackground(opts) {
  const {
    provider,
    orderId,
    deviceId,
    prevPayload,
    cred,
    phone,
    amount,
    initiate,
    onProviderResult,
    providerBodyKey = provider,
    resolveExternalId,
  } = opts
  void (async () => {
    const t0 = Date.now()
    try {
      const result = await initiate(cred, { phone, amount, orderId, currency: 'TZS' })
      if (onProviderResult) {
        await onProviderResult(result).catch((e) => {
          console.warn(LOG, 'onProviderResult failed', orderId, e?.message || e)
        })
      }
      const providerOrderId = resolveExternalId
        ? resolveExternalId(result)
        : result.normalized?.providerOrderId ??
          (result.body?.data?.order_id != null ? String(result.body.data.order_id) : null)
      await billing.updateTransactionByOrderId(orderId, {
        status: result.ok ? 'pending' : 'failed',
        external_id: providerOrderId,
        raw_payload: {
          ...prevPayload,
          [providerBodyKey]: result.body,
          provider_order_id: providerOrderId,
          httpStatus: result.status,
          provider_initiation_ms: Date.now() - t0,
          provider_initiation: result.ok ? 'accepted' : 'failed',
        },
      })
      liveSyncBus.publish('analytics.transaction_updated', {
        topics: ['analytics'],
        orderId,
        status: result.ok ? 'pending' : 'failed',
        deviceId,
      })
      if (result.ok) {
        console.log(LOG, 'provider accepted', {
          provider,
          orderId,
          providerOrderId,
          ms: Date.now() - t0,
        })
      } else {
        console.warn(LOG, 'provider rejected', {
          provider,
          orderId,
          httpStatus: result.status,
          ms: Date.now() - t0,
          body: result.body,
        })
      }
    } catch (e) {
      console.error(LOG, 'provider initiation error', { provider, orderId, error: e })
      try {
        await billing.updateTransactionByOrderId(orderId, {
          status: 'failed',
          raw_payload: {
            ...prevPayload,
            provider_initiation: 'error',
            provider_initiation_ms: Date.now() - t0,
            provider_error: String(e?.message || e),
          },
        })
        liveSyncBus.publish('analytics.transaction_updated', {
          topics: ['analytics'],
          orderId,
          status: 'failed',
          deviceId,
        })
      } catch (inner) {
        console.error(LOG, 'failed to mark txn failed', orderId, inner)
      }
    }
  })()
}
