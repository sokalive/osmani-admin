/**
 * Shared SonicPesa webhook parsing helpers (no route/billing deps).
 */
import {
  normalizeResponse,
  sonicExplicitFailure as explicitFailure,
  sonicPaymentSucceeded as paymentSucceeded,
} from './payments/providers/sonicpesa.js'

const COMPLETION_EVENTS = new Set([
  'payment.completed',
  'payment.success',
  'payment_completed',
  'payment_success',
])

export function isProviderCompletionEvent(body) {
  const o = body && typeof body === 'object' ? body : {}
  const ev = String(o.event ?? o.type ?? '').trim().toLowerCase()
  if (!ev) return true
  if (COMPLETION_EVENTS.has(ev)) return true
  if (ev.includes('completed') || ev.includes('success')) return true
  return false
}

/** Compare provider webhook amount (integer TZS) to internal transaction amount. */
export function webhookAmountMatchesTxn(txn, body) {
  const o = body && typeof body === 'object' ? body : {}
  const nested = o.data && typeof o.data === 'object' ? o.data : o
  const webhookAmount = Number(nested.amount ?? o.amount)
  const txnAmount = Number(txn?.amount)
  if (!Number.isFinite(webhookAmount) || webhookAmount <= 0) return true
  if (!Number.isFinite(txnAmount) || txnAmount <= 0) return true
  return Math.abs(Math.round(webhookAmount) - Math.round(txnAmount)) <= 1
}

export function extractWebhookTransId(body) {
  const o = body && typeof body === 'object' ? body : {}
  const nested = o.data && typeof o.data === 'object' ? o.data : o
  return String(
    nested.transid ?? nested.transaction_id ?? o.transid ?? o.transaction_id ?? '',
  ).trim()
}

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
