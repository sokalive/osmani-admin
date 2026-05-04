import * as billing from '../billingStore.js'
import { readJson, writeJsonAtomic } from '../lib/jsonFile.js'
import { formatPhone } from '../zenopayClient.js'

const USERS_FILE = 'users.json'

function subscriptionExpiresAt(plan, from = new Date()) {
  const d = new Date(from.getTime())
  const days = Math.max(1, Number(plan?.duration_days) || 30)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString()
}

/** ZenoPay often sends `payment_status: "COMPLETED"` under `data` — read all layers. */
function statusStringsFromWebhook(body) {
  const nested = [body, body?.data, body?.payload, body?.payment, body?.transaction].filter(
    (x) => x && typeof x === 'object',
  )
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

function webhookSuccess(body) {
  for (const raw of statusStringsFromWebhook(body)) {
    const s = raw.toLowerCase()
    if (['completed', 'success', 'paid', 'successful', 'ok'].includes(s)) return true
  }
  if (body?.success === true || body?.paid === true) return true
  const d = body?.data
  if (d && typeof d === 'object' && (d.success === true || d.paid === true)) return true
  return false
}

function webhookExplicitFailure(body) {
  for (const raw of statusStringsFromWebhook(body)) {
    const s = raw.toLowerCase()
    if (['failed', 'error', 'declined', 'cancelled', 'rejected'].includes(s)) return true
  }
  if (body?.success === false || body?.paid === false) return true
  const d = body?.data
  if (d && typeof d === 'object' && (d.success === false || d.paid === false)) return true
  return false
}

function phoneComparable(raw) {
  const d = String(raw ?? '').replace(/\D/g, '')
  if (!d) return ''
  if (d.startsWith('255')) return d
  if (d.startsWith('0')) return `255${d.slice(1)}`
  return d
}

function webhookBuyerPhoneRaw(body) {
  const nested = [body, body?.data, body?.payload, body?.payment].filter(
    (x) => x && typeof x === 'object',
  )
  const keys = ['buyer_phone', 'phone', 'msisdn', 'customer_phone', 'mobile', 'payer_phone']
  for (const o of nested) {
    for (const k of keys) {
      const v = o[k]
      if (v != null && String(v).trim()) return String(v).trim()
    }
  }
  return ''
}

function resolveSubscriptionPhone(body, txn) {
  const w = webhookBuyerPhoneRaw(body)
  const formatted = w ? formatPhone(w) : ''
  const fromTxn = String(txn?.phone ?? '').trim()
  if (fromTxn.startsWith('+255')) return fromTxn
  if (formatted.startsWith('+255')) return formatted
  return fromTxn || formatted || ''
}

async function findUserIdAndSyncUsersJson(phoneE164, planId, planName, expiresAtIso) {
  const key = phoneComparable(phoneE164)
  if (!key) return { userId: null }
  const users = await readJson(USERS_FILE, [])
  if (!Array.isArray(users)) return { userId: null }
  let userId = null
  const startDateIso = new Date().toISOString()
  const next = users.map((u) => {
    const uk = phoneComparable(u.phone)
    if (uk && uk === key) {
      userId = u.id ?? u.userId ?? null
      return {
        ...u,
        planId: Number.isFinite(Number(planId)) ? Number(planId) : u.planId,
        planName: planName || u.planName,
        startDate: startDateIso,
        expiryDate: expiresAtIso,
      }
    }
    return u
  })
  if (userId != null) {
    await writeJsonAtomic(USERS_FILE, next)
  }
  return { userId }
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
        const phone = resolveSubscriptionPhone(body, txn)
        if (!phone) {
          console.warn('ZENO WEBHOOK: cannot resolve phone for subscription', orderId)
        } else {
          const expiresAt = subscriptionExpiresAt(plan)
          await billing.upsertSubscriptionAfterPayment(phone, txn.plan_id, expiresAt)
          const planName = plan.name != null ? String(plan.name) : ''
          const { userId } = await findUserIdAndSyncUsersJson(
            phone,
            txn.plan_id,
            planName,
            expiresAt,
          )
          console.log('SUBSCRIPTION ACTIVATED:', { userId, phone, expiresAt })
        }
      }
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error('ZENO WEBHOOK error:', e)
    return res.sendStatus(200)
  }
}
