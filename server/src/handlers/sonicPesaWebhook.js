import crypto from 'node:crypto'
import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { webhookExplicitFailure, webhookSuccess } from './zenoPayWebhook.js'

function sonicOrderIdFromBody(body) {
  const o = body && typeof body === 'object' ? body : {}
  return String(o.order_id ?? o.orderId ?? '').trim()
}

function sonicPaymentSucceeded(body) {
  const o = body && typeof body === 'object' ? body : {}
  const ev = String(o.event ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
  if (ev === 'payment_completed' || ev === 'payment.success') return true
  const st = String(o.status ?? '').toUpperCase()
  if (['SUCCESS', 'COMPLETED', 'PAID'].includes(st)) return true
  return webhookSuccess(o)
}

function sonicExplicitFailure(body) {
  const o = body && typeof body === 'object' ? body : {}
  const st = String(o.status ?? '').toUpperCase()
  if (['FAILED', 'DECLINED', 'CANCELLED', 'REJECTED'].includes(st)) return true
  return webhookExplicitFailure(o)
}

function verifyOptionalWebhookSignature(req, body) {
  const secret = String(process.env.SONICPESA_WEBHOOK_SECRET || '').trim()
  if (!secret) return true
  const rawSig = String(req.headers['x-sonicpesa-signature'] ?? req.headers['x-webhook-signature'] ?? '').trim()
  if (!rawSig) return false
  const sig = rawSig.replace(/^sha256=/i, '').trim()
  const raw = JSON.stringify(body ?? {})
  const expectedHex = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  try {
    const a = Buffer.from(expectedHex, 'hex')
    const b = Buffer.from(sig, 'hex')
    if (a.length === b.length && a.length > 0) return crypto.timingSafeEqual(a, b)
  } catch {
    // fall through
  }
  const a2 = Buffer.from(expectedHex, 'utf8')
  const b2 = Buffer.from(sig, 'utf8')
  return a2.length === b2.length && crypto.timingSafeEqual(a2, b2)
}

/**
 * SonicPesa → POST /api/payments/sonicpesa/webhook
 * Sample: { "event":"payment_completed","order_id":"…","amount":10000,"status":"SUCCESS","transid":"…" }
 */
export async function handleSonicPesaWebhook(req, res) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  try {
    if (!verifyOptionalWebhookSignature(req, body)) {
      console.warn('[sonicpesa webhook] missing or invalid signature (SONICPESA_WEBHOOK_SECRET is set)')
      return res.status(401).type('text/plain').send('invalid signature')
    }
    const orderId = sonicOrderIdFromBody(body)
    if (!orderId) {
      return res.sendStatus(200)
    }
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) {
      console.warn('[sonicpesa webhook] unknown order', orderId)
      return res.sendStatus(200)
    }
    const prevPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (prevPayload.payment_provider !== 'sonicpesa') {
      console.warn('[sonicpesa webhook] order not tagged sonicpesa', orderId)
      return res.sendStatus(200)
    }
    const ok = sonicPaymentSucceeded(body)
    const fail = sonicExplicitFailure(body)
    const nextStatus = ok ? 'completed' : fail ? 'failed' : txn.status
    const transId = body.transid ?? body.transaction_id ?? body.external_id
    await billing.updateTransactionByOrderId(orderId, {
      status: nextStatus,
      external_id: transId != null ? String(transId) : txn.external_id,
      raw_payload: {
        ...prevPayload,
        sonic_webhook: body,
        webhookAt: new Date().toISOString(),
      },
    })
    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId,
      status: nextStatus,
      deviceId: txn.device_id,
    })
    if (ok && txn.plan_id) {
      const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn({
        ...txn,
        status: 'completed',
      })
      if (!act.skipped && act.deviceId) {
        deviceSubscriptionBus.emit('update', { deviceId: act.deviceId })
        liveSyncBus.publish('analytics.subscription_updated', {
          topics: ['analytics'],
          deviceId: act.deviceId,
          orderId,
        })
      }
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error('[sonicpesa webhook]', e)
    return res.sendStatus(200)
  }
}
