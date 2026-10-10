import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import * as billing from '../billingStore.js'
import { handleSonicPesaWebhook } from '../handlers/sonicPesaWebhook.js'
import {
  resolveSonicpesaCredentials,
  verifyPayment,
} from '../lib/payments/providers/sonicpesa.js'
import { formatPhone } from '../zenopayClient.js'
import { hashDeviceFingerprint } from '../billingStore.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import { deriveAppWaitingState } from '../lib/paymentAppWaitingState.js'
import { invalidateSubscriptionAccessCache } from '../lib/subscriptionAccessCache.js'
import { runAwaitedSonicpesaCreateOrder } from '../lib/sonicpesaCheckoutFlow.js'
import { noteCheckoutMetric } from '../lib/sonicpesaCheckoutMetrics.js'
import { shouldActivelyReconcile } from '../lib/sonicpesaCheckoutPolicy.js'

export const sonicpesaPaymentsRouter = Router()

function normalizeTzPhone(raw) {
  let s = String(raw ?? '').replace(/\D/g, '')
  if (!s) return ''
  if (s.startsWith('0')) s = `255${s.slice(1)}`
  if (!s.startsWith('255')) s = `255${s}`
  return s
}

function eventLoopLagMs() {
  const start = Date.now()
  return new Promise((resolve) => {
    setImmediate(() => resolve(Math.max(0, Date.now() - start)))
  })
}

/** POST /payments/sonicpesa/create-order — response waits for SonicPesa acceptance. */
sonicpesaPaymentsRouter.post('/create-order', async (req, res) => {
  const handlerStarted = Date.now()
  const correlationId = `sp_${Date.now()}_${randomBytes(4).toString('hex')}`
  const timings = {}
  noteCheckoutMetric('request')
  try {
    timings.eventLoopLagMs = await eventLoopLagMs()
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
    const tPlan = Date.now()
    const plan = await billing.getPlanById(planId)
    timings.planMs = Date.now() - tPlan
    if (!plan || !plan.is_active) {
      return res.status(400).json({ error: 'Plan not found or inactive' })
    }
    const row = await billing.getSonicpesaRow()
    if (!row || row.enabled !== true) {
      return res.status(503).json({ error: 'SonicPesa is disabled or not configured in admin' })
    }
    const {
      assertNoActiveSubscriptionForPayment,
      activeSubscriptionExistsHttpBody,
    } = await import('../lib/activeSubscriptionPaymentGate.js')
    const tGate = Date.now()
    const activeGate = await assertNoActiveSubscriptionForPayment(deviceId)
    timings.subscriptionGateMs = Date.now() - tGate
    if (!activeGate.ok) {
      console.warn('[sonicpesa] create-order blocked — ACTIVE_SUBSCRIPTION_EXISTS', {
        deviceId: deviceId.length > 24 ? `${deviceId.slice(0, 22)}…` : deviceId,
        expiresAt: activeGate.expiresAt,
      })
      return res.status(409).json(activeSubscriptionExistsHttpBody(activeGate))
    }
    const {
      assertPhoneSubscriptionPaymentAllowed,
      phoneSubscriptionConflictHttpBody,
    } = await import('../lib/phoneSubscriptionGuard.js')
    const tPhone = Date.now()
    const phoneGate = await assertPhoneSubscriptionPaymentAllowed(deviceId, phoneE164)
    timings.phoneGateMs = Date.now() - tPhone
    if (!phoneGate.ok) {
      console.warn('[sonicpesa] create-order blocked — phone subscription conflict', {
        deviceId: deviceId.length > 24 ? `${deviceId.slice(0, 22)}…` : deviceId,
        ownerDeviceId:
          phoneGate.ownerDeviceId && phoneGate.ownerDeviceId.length > 24
            ? `${phoneGate.ownerDeviceId.slice(0, 22)}…`
            : phoneGate.ownerDeviceId,
        code: phoneGate.code || phoneGate.reason,
      })
      return res.status(409).json(phoneSubscriptionConflictHttpBody(phoneGate))
    }
    const cred = resolveSonicpesaCredentials(row)
    if (!cred.apiKey) {
      return res.status(503).json({ error: 'SonicPesa credentials incomplete (admin or env)' })
    }
    await runAwaitedSonicpesaCreateOrder({
      res,
      deviceId,
      phone,
      phoneE164,
      plan,
      planId,
      cred,
      fingerprintPayload,
      correlationId,
      timings,
    })
    timings.totalMs = Date.now() - handlerStarted
    noteCheckoutMetric('handler_done', { handlerMs: timings.totalMs })
    console.log('[sonicpesa] create-order timing', {
      correlationId,
      planMs: timings.planMs ?? null,
      subscriptionGateMs: timings.subscriptionGateMs ?? null,
      phoneGateMs: timings.phoneGateMs ?? null,
      lockMs: timings.lockMs ?? null,
      insertMs: timings.insertMs ?? null,
      providerMs: timings.providerMs ?? null,
      eventLoopLagMs: timings.eventLoopLagMs ?? null,
      totalMs: timings.totalMs,
    })
  } catch (e) {
    console.error('[sonicpesa] create-order failed', { correlationId, name: e?.name || 'Error' })
    if (!res.headersSent) res.status(500).json({ error: 'Imeshindwa kuanzisha malipo. Jaribu tena baadae.' })
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
    if (deviceId) {
      // Always try finalize — covers webhook/poll races where txn is already completed.
      if (txn.status === 'completed' || txn.status === 'pending') {
        try {
          await billing.tryFinalizeActivationForDevice(deviceId)
        } catch (e) {
          console.warn('[sonicpesa/status] finalize failed:', e?.message || e)
        }
      }
      invalidateSubscriptionAccessCache(deviceId)
      const sub = await billing.getDeviceSubscriptionAccessStateFast(deviceId)
      const isActiveNow = sub?.active_now === true || sub?.active === true
      subscriptionActive =
        isActiveNow === true && String(sub?.transaction_id ?? '') === String(txn.order_id)
      if (rec.activation?.activated || rec.activation?.entitlement_active || subscriptionActive) {
        invalidateSubscriptionAccessCache(deviceId)
      }
    }
    const waiting = deriveAppWaitingState({
      txn,
      activation: rec.activation,
      subscriptionActive,
    })
    // Prefer entitlement truth for App unlock UX even if provider poll is lagging.
    const st = subscriptionActive
      ? 'SUCCESS'
      : txn.status === 'completed'
        ? 'SUCCESS'
        : txn.status === 'failed'
          ? 'FAILED'
          : 'PENDING'
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
    const verifyId = String(txn.raw_payload?.provider_order_id ?? txn.external_id ?? '').trim()
    const sp = shouldActivelyReconcile(txn)
      ? await verifyPayment(cred, verifyId)
      : { ok: false, status: 0, body: null, skipped: true }
    const deviceId = String(txn.device_id ?? '').trim()
    let subscriptionActive = false
    if (deviceId) {
      if (txn.status === 'completed' || txn.status === 'pending') {
        try {
          await billing.tryFinalizeActivationForDevice(deviceId)
        } catch (e) {
          console.warn('[sonicpesa/verify] finalize failed:', e?.message || e)
        }
      }
      invalidateSubscriptionAccessCache(deviceId)
      const sub = await billing.getDeviceSubscriptionAccessStateFast(deviceId)
      const isActiveNow = sub?.active_now === true || sub?.active === true
      subscriptionActive =
        isActiveNow === true && String(sub?.transaction_id ?? '') === String(txn.order_id)
      if (rec.activation?.activated || rec.activation?.entitlement_active || subscriptionActive) {
        invalidateSubscriptionAccessCache(deviceId)
      }
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
