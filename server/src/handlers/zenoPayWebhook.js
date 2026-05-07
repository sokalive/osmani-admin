import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

/** ZenoPay often sends `payment_status: "COMPLETED"` under `data` — read all layers. */
function statusStringsFromWebhook(body) {
  const nested = [body, body?.data, body?.payload, body?.payment, body?.transaction].filter(
    (x) => x && typeof x === 'object',
  )
  /** Order-status API returns `data: [{ payment_status: "COMPLETED" }]`. */
  if (Array.isArray(body?.data)) {
    for (const item of body.data) {
      if (item && typeof item === 'object') nested.push(item)
    }
  }
  const keys = ['payment_status', 'status', 'state', 'result']
  const out = []
  const seen = new Set()
  for (const o of nested) {
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

export function webhookSuccess(body) {
  for (const raw of statusStringsFromWebhook(body)) {
    const s = raw.toLowerCase()
    if (['completed', 'success', 'paid', 'successful', 'ok'].includes(s)) return true
  }
  if (body?.success === true || body?.paid === true) return true
  const d = body?.data
  if (d && typeof d === 'object' && (d.success === true || d.paid === true)) return true
  return false
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
        deviceSubscriptionBus.emit('update', { deviceId: act.deviceId })
        liveSyncBus.publish('analytics.subscription_updated', {
          topics: ['analytics'],
          deviceId: act.deviceId,
          orderId,
        })
      }
      console.log('DEVICE SUBSCRIPTION WEBHOOK:', { ...act, orderId })
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error('ZENO WEBHOOK error:', e)
    return res.sendStatus(200)
  }
}
