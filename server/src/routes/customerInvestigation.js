import { Router } from 'express'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { investigateCustomerPayment } from '../lib/customerPaymentInvestigation.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import * as billing from '../billingStore.js'
import { getPool } from '../db/pool.js'
import { executeAdminForceTransfer } from './deviceSecurity.js'

export const customerInvestigationRouter = Router()

customerInvestigationRouter.use(requireAdminPanelAccess)

function parseSearchQuery(req) {
  const q = req.query && typeof req.query === 'object' ? req.query : {}
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  return {
    phone: q.phone ?? q.payment_phone ?? b.phone ?? b.payment_phone ?? q.q ?? b.q,
    device_id: q.device_id ?? b.device_id ?? q.deviceId ?? b.deviceId,
    order_id: q.order_id ?? b.order_id ?? q.orderId ?? b.orderId,
    transaction_id: q.transaction_id ?? b.transaction_id,
    external_id: q.external_id ?? b.external_id ?? q.provider_reference ?? b.provider_reference,
    account_id: q.account_id ?? b.account_id,
    install_instance_id: q.install_instance_id ?? b.install_instance_id,
  }
}

/** Read-only investigation — no mutations. */
customerInvestigationRouter.get('/investigate', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const report = await investigateCustomerPayment(parseSearchQuery(req))
    if (!report.ok) return res.status(400).json(report)
    res.json(report)
  } catch (e) {
    console.error('[customer-investigation] GET /investigate', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

customerInvestigationRouter.post('/investigate', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const report = await investigateCustomerPayment(parseSearchQuery(req))
    if (!report.ok) return res.status(400).json(report)
    res.json(report)
  } catch (e) {
    console.error('[customer-investigation] POST /investigate', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

customerInvestigationRouter.post('/actions/reconcile', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    if (b.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'confirm:true is required' })
    }
    const orderId = String(b.order_id ?? '').trim()
    if (!orderId) return res.status(400).json({ ok: false, error: 'order_id is required' })
    const rec = await reconcileOrderWithZenoPay(orderId, { forcePoll: true })
    const txn = await billing.getTransactionByOrderId(orderId)
    res.json({ ok: true, reconcile: rec, transaction: txn })
  } catch (e) {
    console.error('[customer-investigation] reconcile', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

customerInvestigationRouter.post('/actions/refresh-subscription', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(b.device_id ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    const access = await billing.getDeviceSubscriptionAccessState(deviceId, null)
    res.json({ ok: true, device_id: deviceId, access })
  } catch (e) {
    console.error('[customer-investigation] refresh-subscription', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

customerInvestigationRouter.post('/actions/force-activate', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    if (b.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'confirm:true is required' })
    }
    const orderId = String(b.order_id ?? '').trim()
    if (!orderId) return res.status(400).json({ ok: false, error: 'order_id is required' })
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) return res.status(404).json({ ok: false, error: 'Transaction not found' })
    if (String(txn.status) !== 'completed') {
      return res.status(400).json({ ok: false, error: 'Transaction is not completed — reconcile first' })
    }
    const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn(txn)
    res.json({ ok: act.activated === true, activation: act })
  } catch (e) {
    console.error('[customer-investigation] force-activate', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

customerInvestigationRouter.post('/actions/force-transfer', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    if (b.confirm !== true) {
      return res.status(400).json({ ok: false, error: 'confirm:true is required' })
    }
    const paymentPhone = String(b.payment_phone ?? b.phone ?? '').trim()
    const targetDeviceId = String(b.target_device_id ?? b.device_id ?? '').trim()
    if (!paymentPhone || !targetDeviceId) {
      return res.status(400).json({ ok: false, error: 'payment_phone and target_device_id are required' })
    }
    const sourceDeviceId = await billing.findActiveDeviceIdForPaymentPhone(paymentPhone)
    if (!sourceDeviceId) {
      return res.status(404).json({ ok: false, error: 'No active subscription found for this payment phone' })
    }
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    const result = await executeAdminForceTransfer(pool, {
      sourceDeviceId,
      targetDeviceId,
      targetFpHash: null,
      actor: req.adminEmail || 'admin_investigation',
      auditExtra: `customer_investigation_phone:${billing.normalizePhoneDigits(paymentPhone)}`,
    })
    if (!result.ok) return res.status(result.status || 400).json({ ok: false, error: result.error })
    res.json({ ok: true, ...result })
  } catch (e) {
    console.error('[customer-investigation] force-transfer', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
