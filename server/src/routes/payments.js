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
import { resolveSonicpesaCredentials } from '../sonicpesaClient.js'
import { sonicpesaPaymentsRouter } from './sonicpesaPayments.js'

export const paymentsRouter = Router()

paymentsRouter.get('/checkout-providers', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
    const zrow = await billing.getZenopayRow()
    const zcred = resolveZenopayCredentials(zrow || {})
    const zenopay = Boolean(zcred.apiEndpoint && zcred.apiKey)
    const srow = await billing.getSonicpesaRow()
    const scred = resolveSonicpesaCredentials(srow || {})
    const sonicpesa =
      Boolean(srow?.enabled === true) && Boolean(scred.apiEndpoint && scred.apiKey)
    res.json({ ok: true, zenopay, sonicpesa })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

paymentsRouter.use('/sonicpesa', sonicpesaPaymentsRouter)

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
      raw_payload: { step: 'created', phoneNorm: phone, device_id: deviceId },
    })
    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId,
      status: 'pending',
      deviceId,
    })
    const z = await zenopayCreateCollection(cred, {
      phone,
      amount,
      orderId,
    })
    const prevPayload =
      tx.raw_payload && typeof tx.raw_payload === 'object' ? tx.raw_payload : {}
    await billing.updateTransactionByOrderId(orderId, {
      status: z.ok ? 'pending' : 'failed',
      external_id: z.body?.id != null ? String(z.body.id) : null,
      raw_payload: { ...prevPayload, zeno: z.body, httpStatus: z.status },
    })
    if (!z.ok) {
      liveSyncBus.publish('analytics.transaction_updated', {
        topics: ['analytics'],
        orderId,
        status: 'failed',
        deviceId,
      })
    }
    if (!z.ok) {
      return res.status(502).json({
        error: 'ZenoPay collection request failed',
        orderId,
        transactionId: tx.id,
        details: z.body,
      })
    }
    res.status(201).json({
      ok: true,
      orderId,
      deviceId,
      transactionId: tx.id,
      amount,
      currency: 'TZS',
      zeno: z.body,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})
