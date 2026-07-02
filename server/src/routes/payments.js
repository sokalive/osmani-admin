import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import * as billing from '../billingStore.js'
import { handleZenoPayWebhook } from '../handlers/zenoPayWebhook.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import {
  formatPhone,
  resolveZenopayCredentials,
  zenopayCreateCollection,
} from '../zenopayClient.js'
import {
  isAuraxpayConfigured,
  resolveAuraxpayCollectPostUrl,
  resolveAuraxpayCredentials,
} from '../lib/payments/providers/auraxpay.js'
import {
  createOrder,
  resolveSonicpesaCredentials,
} from '../lib/payments/providers/sonicpesa.js'
import { auraxpayPaymentsRouter, handleAuraxpayCreateOrder } from './auraxpayPayments.js'
import { sonicpesaPaymentsRouter } from './sonicpesaPayments.js'
import { hashDeviceFingerprint } from '../billingStore.js'
import {
  respondCreateOrderAccepted,
  runProviderCreateOrderInBackground,
} from '../lib/paymentCreateOrderPipeline.js'

export const paymentsRouter = Router()

let _checkoutProvidersCache = null
let _checkoutProvidersCacheAt = 0
const CHECKOUT_PROVIDERS_CACHE_MS = Math.max(
  2000,
  Number(process.env.CHECKOUT_PROVIDERS_CACHE_MS) || 30_000,
)

async function buildCheckoutProvidersPayload() {
  const zrow = await billing.getZenopayRow()
  const zcred = resolveZenopayCredentials(zrow || {})
  const zenopay = Boolean(zcred.apiEndpoint && zcred.apiKey)
  const srow = await billing.getSonicpesaRow()
  const scred = resolveSonicpesaCredentials(srow || {})
  const sonicpesa = Boolean(srow?.enabled === true) && Boolean(scred.apiKey)
  const arow = await billing.getAuraxpayRow()
  const acred = resolveAuraxpayCredentials(arow || {})
  const auraxConfigured = isAuraxpayConfigured(acred)
  const auraxpay = Boolean(arow?.enabled === true) && auraxConfigured
  const auraxpay_test = auraxConfigured
  const auraxCollectUrl = auraxConfigured ? resolveAuraxpayCollectPostUrl(acred) : null
  const checkout = await billing.getCheckoutPaymentSettings()
  let payment_provider = checkout.payment_provider
  if (payment_provider === 'auraxpay' && !auraxpay) {
    payment_provider = zenopay ? 'zenopay' : sonicpesa ? 'sonicpesa' : 'zenopay'
  }
  if (payment_provider === 'sonicpesa' && !sonicpesa) {
    payment_provider = zenopay ? 'zenopay' : auraxpay ? 'auraxpay' : 'zenopay'
  }
  if (payment_provider === 'zenopay' && !zenopay) {
    payment_provider = sonicpesa ? 'sonicpesa' : auraxpay ? 'auraxpay' : 'zenopay'
  }
  return {
    ok: true,
    payment_provider,
    zenopay,
    sonicpesa,
    auraxpay,
    aurax: auraxpay,
    auraxpay_test,
    ...(auraxConfigured
      ? {
          aurax_collect_url: auraxCollectUrl,
          aurax_api_endpoint: acred.apiEndpoint,
          aurax_last_create_order_url: arow?.last_create_order_url || null,
          aurax_last_create_order_http_status: arow?.last_create_order_http_status ?? null,
        }
      : {}),
  }
}

paymentsRouter.get('/checkout-providers', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
    const now = Date.now()
    if (_checkoutProvidersCache && now - _checkoutProvidersCacheAt < CHECKOUT_PROVIDERS_CACHE_MS) {
      return res.json(_checkoutProvidersCache)
    }
    const payload = await buildCheckoutProvidersPayload()
    _checkoutProvidersCache = payload
    _checkoutProvidersCacheAt = now
    console.log('[checkout-providers]', {
      zenopay: payload.zenopay,
      sonicpesa: payload.sonicpesa,
      auraxpay: payload.auraxpay,
      payment_provider: payload.payment_provider,
    })
    res.json(payload)
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

paymentsRouter.use('/sonicpesa', sonicpesaPaymentsRouter)
paymentsRouter.use('/auraxpay', auraxpayPaymentsRouter)

paymentsRouter.post('/zeno-webhook', handleZenoPayWebhook)

function normalizeTzPhone(raw) {
  let s = String(raw ?? '').replace(/\D/g, '')
  if (!s) return ''
  if (s.startsWith('0')) s = `255${s.slice(1)}`
  if (!s.startsWith('255')) s = `255${s}`
  return s
}

/** POST /payments/create-payment — uses DB + env ZenoPay credentials */
paymentsRouter.post('/create-payment', async (req, res) => {
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

    const {
      assertPhoneSubscriptionPaymentAllowed,
      phoneSubscriptionConflictHttpBody,
    } = await import('../lib/phoneSubscriptionGuard.js')
    const phoneGate = await assertPhoneSubscriptionPaymentAllowed(deviceId, phoneE164)
    if (!phoneGate.ok) {
      console.warn('[create-payment] blocked — phone subscription conflict', {
        deviceId: deviceId.length > 24 ? `${deviceId.slice(0, 22)}…` : deviceId,
        ownerDeviceId:
          phoneGate.ownerDeviceId && phoneGate.ownerDeviceId.length > 24
            ? `${phoneGate.ownerDeviceId.slice(0, 22)}…`
            : phoneGate.ownerDeviceId,
      })
      return res.status(409).json(phoneSubscriptionConflictHttpBody(phoneGate))
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

    const checkout = await billing.getCheckoutPaymentSettings()
    if (checkout.payment_provider === 'auraxpay') {
      const arow = await billing.getAuraxpayRow()
      const acred = resolveAuraxpayCredentials(arow || {})
      if (arow?.enabled === true && isAuraxpayConfigured(acred)) {
        return handleAuraxpayCreateOrder(req, res, {
          requireEnabled: true,
          context: 'create-payment',
        })
      }
      console.warn('[create-payment] auraxpay selected but not enabled/configured', {
        enabled: arow?.enabled === true,
        configured: isAuraxpayConfigured(acred),
      })
      return res.status(503).json({
        error: 'Aurax Pay is selected as checkout provider but not enabled or configured in admin',
      })
    }
    if (checkout.payment_provider === 'sonicpesa') {
      const srow = await billing.getSonicpesaRow()
      const scred = resolveSonicpesaCredentials(srow || {})
      if (srow?.enabled === true && scred.apiKey) {
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
          cred: scred,
          phone,
          amount,
          initiate: createOrder,
          providerBodyKey: 'sonicpesa',
        })
        return respondCreateOrderAccepted(
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
      }
      console.warn('[create-payment] sonicpesa selected but not enabled/configured', {
        enabled: srow?.enabled === true,
        hasApiKey: Boolean(scred.apiKey),
      })
      return res.status(503).json({
        error: 'SonicPesa is selected as checkout provider but not enabled or configured in admin',
      })
    }

    const row = await billing.getZenopayRow()
    const cred = resolveZenopayCredentials(row)
    if (!cred.apiEndpoint || !cred.apiKey) {
      return res.status(503).json({ error: 'ZenoPay is not configured (admin settings or .env)' })
    }
    const orderId = `osm_${Date.now()}_${randomBytes(5).toString('hex')}`
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
        payment_provider: 'zenopay',
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
      provider: 'zenopay',
      orderId,
      deviceId,
      prevPayload,
      cred,
      phone,
      amount,
      initiate: async (c, args) => zenopayCreateCollection(c, args),
      providerBodyKey: 'zeno',
      resolveExternalId: (z) => (z.body?.id != null ? String(z.body.id) : null),
    })
    respondCreateOrderAccepted(
      res,
      {
        ok: true,
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
