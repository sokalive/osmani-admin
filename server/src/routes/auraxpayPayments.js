import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import * as billing from '../billingStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { handleAuraxPayWebhook } from '../handlers/auraxPayWebhook.js'
import {
  createOrder,
  isAuraxpayConfigured,
  resolveAuraxpayCollectPostUrl,
  resolveAuraxpayCredentials,
} from '../lib/payments/providers/auraxpay.js'
import {
  respondCreateOrderAccepted,
  runProviderCreateOrderInBackground,
} from '../lib/paymentCreateOrderPipeline.js'
import { formatPhone } from '../zenopayClient.js'

export const auraxpayPaymentsRouter = Router()

function normalizeTzPhone(raw) {
  let s = String(raw ?? '').replace(/\D/g, '')
  if (!s) return ''
  if (s.startsWith('0')) s = `255${s.slice(1)}`
  if (!s.startsWith('255')) s = `255${s}`
  return s
}

/**
 * Shared Aurax Pay order creation (mobile + admin test checkout).
 * @param {{ requireEnabled?: boolean, context?: string }} opts
 */
export async function handleAuraxpayCreateOrder(req, res, opts = {}) {
  const requireEnabled = opts.requireEnabled !== false
  const context = String(opts.context || 'public')
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
    const plan = await billing.getPlanById(planId)
    if (!plan || !plan.is_active) {
      return res.status(400).json({ error: 'Plan not found or inactive' })
    }
    const row = await billing.getAuraxpayRow()
    const cred = resolveAuraxpayCredentials(row || {})
    if (!isAuraxpayConfigured(cred)) {
      return res.status(503).json({ error: 'Aurax Pay credentials incomplete (admin or env)' })
    }
    if (requireEnabled && (!row || row.enabled !== true)) {
      console.warn('[auraxpay] create-order blocked — gateway disabled in admin', { context, deviceId })
      return res.status(503).json({ error: 'Aurax Pay is disabled or not configured in admin' })
    }
    const {
      assertPhoneSubscriptionPaymentAllowed,
      phoneSubscriptionConflictHttpBody,
    } = await import('../lib/phoneSubscriptionGuard.js')
    const phoneGate = await assertPhoneSubscriptionPaymentAllowed(deviceId, phoneE164)
    if (!phoneGate.ok) {
      console.warn('[auraxpay] create-order blocked — phone subscription conflict', {
        context,
        deviceId: deviceId.length > 24 ? `${deviceId.slice(0, 22)}…` : deviceId,
        ownerDeviceId:
          phoneGate.ownerDeviceId && phoneGate.ownerDeviceId.length > 24
            ? `${phoneGate.ownerDeviceId.slice(0, 22)}…`
            : phoneGate.ownerDeviceId,
      })
      return res.status(409).json(phoneSubscriptionConflictHttpBody(phoneGate))
    }
    const orderId = `osm_ax_${Date.now()}_${randomBytes(5).toString('hex')}`
    const amount = Number(plan.price)
    console.log('[auraxpay] create-order', {
      context,
      orderId,
      deviceId: deviceId.length > 24 ? `${deviceId.slice(0, 22)}…` : deviceId,
      planId,
      requireEnabled,
      enabled: row?.enabled === true,
      phone: phone.slice(0, 6) + '***',
    })
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
        payment_provider: 'auraxpay',
        phoneNorm: phone,
        device_id: deviceId,
        checkout_context: context,
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
      provider: 'auraxpay',
      orderId,
      deviceId,
      prevPayload,
      cred,
      phone,
      amount,
      initiate: createOrder,
      providerBodyKey: 'auraxpay',
      onProviderResult: async (ax) => {
        await billing.recordAuraxpayCreateOrderAttempt({
          url: ax.collectUrl || resolveAuraxpayCollectPostUrl(cred),
          apiStyle: ax.apiStyle,
          httpStatus: ax.status,
          responseBody: ax.body,
          providerMessage: ax.providerMessage,
        })
      },
    })
    console.log('[auraxpay] create-order accepted (async provider)', { context, orderId })
    respondCreateOrderAccepted(
      res,
      {
        ok: true,
        provider: 'auraxpay',
        provider_alias: 'aurax',
        orderId,
        deviceId,
        transactionId: tx.id,
        amount,
        currency: 'TZS',
      },
      { orderId, deviceId },
    )
  } catch (e) {
    console.error('[auraxpay] create-order error', { context, error: e })
    res.status(500).json({ error: String(e.message || e) })
  }
}

/** POST /payments/auraxpay/create-order — production/mobile (requires enabled) */
auraxpayPaymentsRouter.post('/create-order', (req, res) => {
  void handleAuraxpayCreateOrder(req, res, { requireEnabled: true, context: 'public' })
})

auraxpayPaymentsRouter.post('/webhook', (req, res) => {
  void handleAuraxPayWebhook(req, res)
})

auraxpayPaymentsRouter.get('/status/:orderId', async (req, res) => {
  try {
    const orderId = String(req.params.orderId ?? '').trim()
    if (!orderId) {
      return res.status(400).json({ error: 'orderId is required' })
    }
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) {
      return res.status(404).json({ error: 'Unknown order' })
    }
    const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (raw.payment_provider !== 'auraxpay') {
      return res.status(404).json({ error: 'Not an Aurax Pay order' })
    }
    const st =
      txn.status === 'completed' ? 'SUCCESS' : txn.status === 'failed' ? 'FAILED' : 'PENDING'
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({
      ok: true,
      order_id: txn.order_id,
      provider_order_id: raw.provider_order_id ?? txn.external_id ?? null,
      status: st,
      transaction_status: txn.status,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})
