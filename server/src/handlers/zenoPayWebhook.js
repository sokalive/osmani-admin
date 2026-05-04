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

/**
 * ZenoPay → POST /api/zeno-webhook (and legacy paths). Always HTTP 200 so the provider does not retry storms.
 */
export async function handleZenoPayWebhook(req, res) {
  const body = normalizeWebhookBody(req.body)
  console.log('ZENO WEBHOOK:', body)
  try {
    const orderId = String(
      body.reference ?? body.order_id ?? body.orderId ?? body.order ?? body.merchant_reference ?? '',
    ).trim()
    if (!orderId) {
      console.warn('ZENO WEBHOOK: missing order_id / reference')
      return res.sendStatus(200)
    }
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) {
      console.warn('ZENO WEBHOOK: unknown order', orderId)
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
