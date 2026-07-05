/**
 * Shared SonicPesa webhook parsing helpers (no route/billing deps).
 */
import { normalizeResponse, sonicExplicitFailure as explicitFailure, sonicPaymentSucceeded as paymentSucceeded } from './payments/providers/sonicpesa.js'

export function webhookOrderIdCandidates(body) {
  const o = body && typeof body === 'object' ? body : {}
  const nested = [o.data, o.payment, o.payload, o.transaction].filter(
    (x) => x && typeof x === 'object',
  )
  const objs = [o, ...nested]
  const keys = [
    'order_id',
    'orderId',
    'merchant_order_id',
    'merchant_reference',
    'reference',
    'tx_ref',
  ]
  const out = []
  const seen = new Set()
  for (const obj of objs) {
    for (const k of keys) {
      const v = String(obj[k] ?? '').trim()
      if (v && !seen.has(v)) {
        seen.add(v)
        out.push(v)
      }
    }
  }
  return out
}

export function sonicPaymentSucceeded(body) {
  return paymentSucceeded(body)
}

export function sonicExplicitFailure(body) {
  return explicitFailure(body)
}

export function describeWebhookPaymentStatus(body) {
  const n = normalizeResponse(body)
  return {
    paymentStatus: n.paymentStatus,
    succeeded: n.succeeded,
    failed: n.failed,
  }
}
