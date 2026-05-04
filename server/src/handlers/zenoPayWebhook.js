import * as billing from '../billingStore.js'

function subscriptionExpiresAt(plan, from = new Date()) {
  const d = new Date(from.getTime())
  const days = Math.max(1, Number(plan?.duration_days) || 30)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString()
}

function webhookSuccess(body) {
  const status = String(
    body?.status ?? body?.payment_status ?? body?.state ?? body?.result ?? '',
  ).toLowerCase()
  if (['completed', 'success', 'paid', 'successful', 'ok'].includes(status)) return true
  if (body?.success === true || body?.paid === true) return true
  return false
}

function webhookExplicitFailure(body) {
  const status = String(body?.status ?? body?.payment_status ?? '').toLowerCase()
  if (['failed', 'error', 'declined', 'cancelled', 'rejected'].includes(status)) return true
  if (body?.success === false || body?.paid === false) return true
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
    if (ok && txn.plan_id) {
      const plan = await billing.getPlanRowByIdAny(txn.plan_id)
      if (plan) {
        const phone = String(txn.phone ?? '').trim()
        if (phone) {
          const exp = subscriptionExpiresAt(plan)
          await billing.upsertSubscriptionAfterPayment(phone, txn.plan_id, exp)
        }
      }
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error('ZENO WEBHOOK error:', e)
    return res.sendStatus(200)
  }
}
