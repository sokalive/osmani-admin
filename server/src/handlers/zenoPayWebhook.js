import * as billing from '../billingStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { notifySubscriptionActivatedFromAct } from '../lib/subscriptionActivationNotify.js'

/** Flat objects to scan (excludes arrays mistaken as objects). */
function walkPaymentPayloadObjects(body) {
  if (body == null || typeof body !== 'object') return []
  const out = []
  const push = (x) => {
    if (x && typeof x === 'object' && !Array.isArray(x)) out.push(x)
  }
  push(body)
  push(body.data)
  push(body.payload)
  push(body.payment)
  push(body.transaction)
  if (Array.isArray(body.data)) {
    for (const item of body.data) {
      push(item)
    }
  }
  return out
}

const PENDING_LIKE_PAYMENT = new Set([
  'pending',
  'processing',
  'initiated',
  'created',
  'sent',
  'waiting',
  'queued',
  'submitted',
  'partial',
  'in_progress',
  'inprogress',
  'awaiting',
  'open',
  'new',
])

const SETTLED_PAYMENT_STATUS = new Set([
  'completed',
  'paid',
  'success',
  'successful',
  'succeeded',
  'ok',
  'confirmed',
  'captured',
  'complete',
])

function norm(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
}

function isPendingLikeStatus(s) {
  return PENDING_LIKE_PAYMENT.has(norm(s))
}

function isSettledPaymentStatusField(s) {
  const v = norm(s)
  if (!v || isPendingLikeStatus(v)) return false
  return SETTLED_PAYMENT_STATUS.has(v)
}

/** Only `completed` / `paid` on generic `status`/`state`/`result` — not `success` (often means “STK sent”, HTTP OK). */
function isConservativeGenericPaid(s) {
  const v = norm(s)
  return v === 'completed' || v === 'paid'
}

/**
 * True when provider payload shows settled funds (webhook or order-status poll).
 * Does not treat bare `success: true` / generic `status: "success"` as paid — that caused early activation.
 */
export function webhookSuccess(body) {
  const objs = walkPaymentPayloadObjects(body)
  for (const o of objs) {
    for (const pk of ['payment_status', 'PaymentStatus', 'paymentStatus']) {
      if (!(pk in o)) continue
      const raw = o[pk]
      if (raw == null || raw === '') continue
      if (isSettledPaymentStatusField(raw)) return true
    }
  }
  for (const o of objs) {
    for (const gk of ['status', 'state', 'result']) {
      if (!(gk in o)) continue
      const raw = o[gk]
      if (raw == null || raw === '') continue
      if (isPendingLikeStatus(raw)) continue
      if (isConservativeGenericPaid(raw)) return true
    }
  }
  if (body?.paid === true) return true
  const d = body?.data
  if (d && typeof d === 'object' && !Array.isArray(d) && d.paid === true) return true
  return false
}

/** ZenoPay often sends `payment_status: "COMPLETED"` under `data` — read all layers. */
function statusStringsFromWebhook(body) {
  const objs = walkPaymentPayloadObjects(body)
  const keys = ['payment_status', 'status', 'state', 'result']
  const out = []
  const seen = new Set()
  for (const o of objs) {
    for (const k of keys) {
      const v = o[k]
      if (v == null || v === '') continue
      const s = String(v).trim()
      if (s && !seen.has(s)) {
        seen.add(s)
        out.push(s)
      }
    }
  }
  return out
}

export function webhookExplicitFailure(body) {
  for (const raw of statusStringsFromWebhook(body)) {
    const s = raw.toLowerCase()
    if (['failed', 'error', 'declined', 'cancelled', 'rejected'].includes(s)) return true
  }
  if (body?.success === false || body?.paid === false) return true
  const d = body?.data
  if (d && typeof d === 'object' && (d.success === false || d.paid === false)) return true
  return false
}

function normalizeWebhookBody(raw) {
  if (raw == null) return {}
  if (typeof raw === 'string') {
    try {
      const o = JSON.parse(raw)
      return o && typeof o === 'object' ? o : {}
    } catch {
      return {}
    }
  }
  return typeof raw === 'object' ? raw : {}
}

/** Collect possible merchant order ids (same string as `transactions.order_id`) from flat + nested bodies. */
function webhookOrderIdCandidates(body) {
  const nested = [body?.data, body?.payload, body?.payment, body?.transaction].filter(
    (x) => x && typeof x === 'object',
  )
  const objs = [body, ...nested].filter((x) => x && typeof x === 'object')
  const keys = [
    'order_id',
    'reference',
    'orderId',
    'tx_ref',
    'merchant_reference',
    'order',
  ]
  const seen = new Set()
  const out = []
  for (const obj of objs) {
    for (const k of keys) {
      const s = String(obj[k] ?? '').trim()
      if (s && !seen.has(s)) {
        seen.add(s)
        out.push(s)
      }
    }
  }
  return out
}

/**
 * ZenoPay → POST /api/zeno-webhook (and legacy paths). Always HTTP 200 so the provider does not retry storms.
 */
export async function handleZenoPayWebhook(req, res) {
  const body = normalizeWebhookBody(req.body)
  console.log('ZENO WEBHOOK:', body)
  try {
    const candidates = webhookOrderIdCandidates(body)
    let txn = null
    let orderId = ''
    for (const c of candidates) {
      const row = await billing.getTransactionByOrderId(c)
      if (row) {
        txn = row
        orderId = c
        break
      }
    }
    console.log('WEBHOOK ORDER ID:', orderId || '(none matched DB)')
    if (candidates.length) {
      console.log('WEBHOOK ORDER ID CANDIDATES (transactions.order_id):', candidates)
    }
    if (!orderId || !txn) {
      console.warn('ZENO WEBHOOK: unknown order — no candidate matched transactions.order_id')
      return res.sendStatus(200)
    }
    const ok = webhookSuccess(body)
    const fail = webhookExplicitFailure(body)
    const nextStatus = ok ? 'completed' : fail ? 'failed' : txn.status
    const prevPayload =
      txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    await billing.updateTransactionByOrderId(orderId, {
      status: nextStatus,
      external_id: body.transaction_id != null ? String(body.transaction_id) : null,
      raw_payload: {
        ...prevPayload,
        webhook: body,
        webhookAt: new Date().toISOString(),
      },
    })
    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId,
      status: nextStatus,
    })
    if (ok && txn.plan_id) {
      const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn({
        ...txn,
        status: 'completed',
      })
      if (act.reason === 'plan_not_found') {
        console.warn('ZENO WEBHOOK: plan not found for transaction', orderId)
      } else if (act.reason === 'no_device_id') {
        console.warn(
          'ZENO WEBHOOK: transaction missing device_id — cannot activate device_subscription',
          orderId,
        )
      } else if (!act.skipped && act.deviceId) {
        notifySubscriptionActivatedFromAct(act, orderId)
      }
      console.log('DEVICE SUBSCRIPTION WEBHOOK:', { ...act, orderId })
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error('ZENO WEBHOOK error:', e)
    return res.sendStatus(200)
  }
}
