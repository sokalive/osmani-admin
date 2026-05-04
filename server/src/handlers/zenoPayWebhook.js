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

export async function handleZenoPayWebhook(req, res) {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const orderId = String(
      body.reference ?? body.order_id ?? body.orderId ?? body.order ?? body.merchant_reference ?? '',
    ).trim()
    if (!orderId) {
      return res.status(400).json({ error: 'Missing order reference' })
    }
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) {
      return res.status(404).json({ error: 'Unknown order' })
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
    res.json({ ok: true, orderId, status: nextStatus })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
}
