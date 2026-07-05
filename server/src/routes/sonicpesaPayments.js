import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import * as billing from '../billingStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { handleSonicPesaWebhook } from '../handlers/sonicPesaWebhook.js'
import {
  createOrder,
  resolveSonicpesaCredentials,
  verifyPayment,
} from '../lib/payments/providers/sonicpesa.js'
import { formatPhone } from '../zenopayClient.js'
import { hashDeviceFingerprint } from '../billingStore.js'
import {
  respondCreateOrderAccepted,
  runProviderCreateOrderInBackground,
} from '../lib/paymentCreateOrderPipeline.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import { deriveAppWaitingState } from '../lib/paymentAppWaitingState.js'
import { invalidateSubscriptionAccessCache } from '../lib/subscriptionAccessCache.js'

export const sonicpesaPaymentsRouter = Router()

function normalizeTzPhone(raw) {
  let s = String(raw ?? '').replace(/\D/g, '')
  if (!s) return ''
  if (s.startsWith('0')) s = `255${s.slice(1)}`
  if (!s.startsWith('255')) s = `255${s}`
  return s
}

/** POST /payments/sonicpesa/create-order — parallel to ZenoPay create-payment */
sonicpesaPaymentsRouter.post('/create-order', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const planId = Number(b.planId ?? b.plan_id)
    const deviceId = String(b.deviceId ?? b.device_id ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required (client device identifier)' })
    }
    const phoneRaw = String(b.phone ?? '').trim()
    const phone = normalizeTzPhone(phoneRaw)
    if (!phone || !Number.isFinite(planId)) {
      return res.status(400).json({ error: 'phone and planId are required' })
    }
    const phoneE164 = formatPhone(phone)
    if (!phoneE164.startsWith('+255') || phoneE164.length < 13) {
      return res.status(400).json({ error: 'phone must be a valid Tanzania number (+255…)' })
    }
    const fpRaw = String(
      b.device_fingerprint ?? b.fingerprint ?? b.deviceFingerprint ?? '',
    ).trim()
    const fingerprintPayload = fpRaw
      ? {
          fingerprint: fpRaw,
          device_fingerprint: fpRaw,
          fingerprint_hash: hashDeviceFingerprint(fpRaw),
        }
      : {}
    const plan = await billing.getPlanById(planId)
    if (!plan || !plan.is_active) {
      return res.status(400).json({ error: 'Plan not found or inactive' })
    }
    const row = await billing.getSonicpesaRow()
    if (!row || row.enabled !== true) {
      return res.status(503).json({ error: 'SonicPesa is disabled or not configured in admin' })
    }
    const {
      assertPhoneSubscriptionPaymentAllowed,
      phoneSubscriptionConflictHttpBody,
    } = await import('../lib/phoneSubscriptionGuard.js')
    const phoneGate = await assertPhoneSubscriptionPaymentAllowed(deviceId, phoneE164)
    if (!phoneGate.ok) {
      console.warn('[sonicpesa] create-order blocked — phone subscription conflict', {
        deviceId: deviceId.length > 24 ? `${deviceId.slice(0, 22)}…` : deviceId,
        ownerDeviceId:
          phoneGate.ownerDeviceId && phoneGate.ownerDeviceId.length > 24
            ? `${phoneGate.ownerDeviceId.slice(0, 22)}…`
            : phoneGate.ownerDeviceId,
      })
      return res.status(409).json(phoneSubscriptionConflictHttpBody(phoneGate))
    }
    const cred = resolveSonicpesaCredentials(row)
    if (!cred.apiKey) {
      return res.status(503).json({ error: 'SonicPesa credentials incomplete (admin or env)' })
    }
    const orderId = `osm_sp_${Date.now()}_${randomBytes(5).toString('hex')}`
    const amount = Number(plan.price)
    const tx = await billing.insertTransaction({
      order_id: orderId,
      plan_id: planId,
      phone: phoneE164,
      amount,
      currency: 'TZS',
      status: 'pending',
      device_id: deviceId,
      raw_payload: {
        step: 'created',
        payment_provider: 'sonicpesa',
        phoneNorm: phone,
        device_id: deviceId,
        ...fingerprintPayload,
      },
    })
    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId,
      status: 'pending',
      deviceId,
    })
    const prevPayload =
      tx.raw_payload && typeof tx.raw_payload === 'object' ? tx.raw_payload : {}
    runProviderCreateOrderInBackground({
      provider: 'sonicpesa',
      orderId,
      deviceId,
      prevPayload,
      cred,
      phone,
      amount,
      initiate: createOrder,
      providerBodyKey: 'sonicpesa',
    })
    respondCreateOrderAccepted(
      res,
      {
        ok: true,
        provider: 'sonicpesa',
        orderId,
        deviceId,
        transactionId: tx.id,
        amount,
        currency: 'TZS',
      },
      { orderId, deviceId },
    )
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

sonicpesaPaymentsRouter.post('/webhook', (req, res) => {
  void handleSonicPesaWebhook(req, res)
})

/** GET /payments/sonicpesa/status/:orderId — reconcile + App waiting state */
sonicpesaPaymentsRouter.get('/status/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId ?? '').trim()
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' })
    }
    const rec = await reconcileOrderWithZenoPay(orderId, { forcePoll: true })
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) {
      return res.status(404).json({ error: 'Unknown order' })
    }
    const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (raw.payment_provider !== 'sonicpesa') {
      return res.status(404).json({ error: 'Not a SonicPesa order' })
    }
    const deviceId = String(txn.device_id ?? '').trim()
    let subscriptionActive = false
    if (deviceId && txn.status === 'completed') {
      const sub = await billing.getDeviceSubscriptionAccessStateFast(deviceId)
      subscriptionActive =
        sub?.active === true && String(sub.transaction_id ?? '') === String(txn.order_id)
      if (rec.activation?.activated) invalidateSubscriptionAccessCache(deviceId)
    }
    const waiting = deriveAppWaitingState({
      txn,
      activation: rec.activation,
      subscriptionActive,
    })
    const st =
      txn.status === 'completed' ? 'SUCCESS' : txn.status === 'failed' ? 'FAILED' : 'PENDING'
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({
      ok: true,
      order_id: txn.order_id,
      provider_order_id: raw.provider_order_id ?? txn.external_id ?? null,
      status: st,
      transaction_status: txn.status,
      reconcile_phase: rec.phase,
      ...waiting,
      activation: rec.activation ?? null,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** GET /payments/sonicpesa/verify/:orderId — poll provider then return normalized status */
sonicpesaPaymentsRouter.get('/verify/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId ?? '').trim()
    const rec = await reconcileOrderWithZenoPay(orderId, { forcePoll: true })
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) return res.status(404).json({ error: 'Unknown order' })
    const row = await billing.getSonicpesaRow()
    const cred = resolveSonicpesaCredentials(row || {})
    const verifyId = String(
      txn.raw_payload?.provider_order_id ?? txn.external_id ?? orderId,
    ).trim()
    const sp = await verifyPayment(cred, verifyId)
    const deviceId = String(txn.device_id ?? '').trim()
    let subscriptionActive = false
    if (deviceId && txn.status === 'completed') {
      const sub = await billing.getDeviceSubscriptionAccessStateFast(deviceId)
      subscriptionActive =
        sub?.active === true && String(sub.transaction_id ?? '') === String(txn.order_id)
      if (rec.activation?.activated) invalidateSubscriptionAccessCache(deviceId)
    }
    const waiting = deriveAppWaitingState({
      txn,
      activation: rec.activation,
      subscriptionActive,
    })
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({
      ok: true,
      order_id: orderId,
      provider_order_id: verifyId,
      http_ok: sp.ok,
      normalized: sp.normalized,
      transaction_status: txn.status,
      reconcile_phase: rec.phase,
      ...waiting,
      activation: rec.activation ?? null,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})
