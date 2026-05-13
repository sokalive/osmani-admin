import { randomBytes } from 'node:crypto'
import { Router } from 'express'
import * as billing from '../billingStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { formatPhone } from '../zenopayClient.js'
import { handleSonicPesaWebhook } from '../handlers/sonicPesaWebhook.js'
import { resolveSonicpesaCredentials, sonicpesaInitiatePayment } from '../sonicpesaClient.js'

export const sonicpesaPaymentsRouter = Router()

function normalizeTzPhone(raw) {
  let s = String(raw ?? '').replace(/\D/g, '')
  if (!s) return ''
  if (s.startsWith('0')) s = `255${s.slice(1)}`
  if (!s.startsWith('255')) s = `255${s}`
  return s
}

/** POST /payments/sonicpesa/create-order — parallel to ZenoPay create-payment; tags raw_payload.payment_provider */
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
    const plan = await billing.getPlanById(planId)
    if (!plan || !plan.is_active) {
      return res.status(400).json({ error: 'Plan not found or inactive' })
    }
    const row = await billing.getSonicpesaRow()
    if (!row || row.enabled !== true) {
      return res.status(503).json({ error: 'SonicPesa is disabled or not configured in admin' })
    }
    const cred = resolveSonicpesaCredentials(row)
    if (!cred.apiEndpoint || !cred.apiKey) {
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
      },
    })
    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId,
      status: 'pending',
      deviceId,
    })
    const sp = await sonicpesaInitiatePayment(cred, {
      phone,
      amount,
      orderId,
    })
    const prevPayload =
      tx.raw_payload && typeof tx.raw_payload === 'object' ? tx.raw_payload : {}
    await billing.updateTransactionByOrderId(orderId, {
      status: sp.ok ? 'pending' : 'failed',
      external_id: sp.body?.id != null ? String(sp.body.id) : null,
      raw_payload: { ...prevPayload, sonicpesa: sp.body, httpStatus: sp.status },
    })
    if (!sp.ok) {
      liveSyncBus.publish('analytics.transaction_updated', {
        topics: ['analytics'],
        orderId,
        status: 'failed',
        deviceId,
      })
      return res.status(502).json({
        error: 'SonicPesa payment initiation failed',
        orderId,
        transactionId: tx.id,
        details: sp.body,
      })
    }
    res.status(201).json({
      ok: true,
      provider: 'sonicpesa',
      orderId,
      deviceId,
      transactionId: tx.id,
      amount,
      currency: 'TZS',
      sonicpesa: sp.body,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

sonicpesaPaymentsRouter.post('/webhook', (req, res) => {
  void handleSonicPesaWebhook(req, res)
})

/** GET /payments/sonicpesa/status/:orderId — lightweight status for clients */
sonicpesaPaymentsRouter.get('/status/:orderId', async (req, res) => {
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
    if (raw.payment_provider !== 'sonicpesa') {
      return res.status(404).json({ error: 'Not a SonicPesa order' })
    }
    const st =
      txn.status === 'completed' ? 'SUCCESS' : txn.status === 'failed' ? 'FAILED' : 'PENDING'
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({
      ok: true,
      order_id: txn.order_id,
      status: st,
      transaction_status: txn.status,
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})
