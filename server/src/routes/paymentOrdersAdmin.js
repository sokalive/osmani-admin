import { Router } from 'express'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { verifyAdminSensitiveActionPassword } from '../lib/adminSensitiveActionPassword.js'
import {
  listPaymentOrdersLedger,
  countPaymentOrdersLedger,
  getPaymentOrderDetail,
} from '../lib/paymentOrderLedger.js'
import {
  recoverAdminPaymentOrder,
  rejectAdminPaymentRecovery,
  reconcilePaymentOrder,
  getPaymentRecoveryEligibility,
} from '../lib/adminPaymentRecovery.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const paymentOrdersAdminRouter = Router()
paymentOrdersAdminRouter.use(requireAdminPanelAccess)

function adminLabel(req) {
  if (req?.adminAuth?.email) return String(req.adminAuth.email).trim().slice(0, 256)
  if (req?.adminAuth?.legacy) return 'legacy_token'
  return 'admin'
}

async function handleRecover(req, res) {
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  const pin = String(b.pin ?? b.security_pin ?? '').trim()
  if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
  if (!verifyAdminSensitiveActionPassword(pin)) {
    return res.status(403).json({ ok: false, error: 'Invalid PIN' })
  }
  if (b.confirm !== true) {
    return res.status(400).json({ ok: false, error: 'confirm:true is required' })
  }
  const orderId = String(req.params.orderId ?? b.order_id ?? '').trim()
  const ownerOverride = b.owner_override === true || b.ownerOverride === true
  const result = await recoverAdminPaymentOrder({
    orderId,
    adminIdentity: adminLabel(req),
    reason: b.reason ?? '',
    idempotencyKey: b.idempotency_key ?? `admin_recovery:${orderId}`,
    ownerOverride,
    attemptProviderPoll: b.attempt_provider_poll !== false,
  })
  if (result.blocked) {
    return res.status(409).json({ ok: false, ...result })
  }
  liveSyncBus.publish('analytics.transaction_updated', {
    topics: ['analytics'],
    orderId,
    action: 'admin_payment_recovery',
    deviceId: result.deviceId ?? null,
    path: result.path ?? null,
  })
  res.json({ ok: true, ...result })
}

paymentOrdersAdminRouter.get('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const q = req.query || {}
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 50))
    const page = Math.max(1, Number(q.page) || 1)
    const offset =
      q.offset != null && q.offset !== ''
        ? Math.max(0, Number(q.offset) || 0)
        : (page - 1) * limit
    const filters = {
      status: q.status ?? 'all',
      provider: q.provider ?? 'all',
      search: q.search ?? q.q ?? '',
    }
    const [rows, total] = await Promise.all([
      listPaymentOrdersLedger({ ...filters, limit, offset }),
      countPaymentOrdersLedger(filters),
    ])
    const totalPages = Math.max(1, Math.ceil(total / limit))
    res.json({
      ok: true,
      rows,
      count: rows.length,
      total,
      page,
      limit,
      offset,
      totalPages,
    })
  } catch (e) {
    console.error('[payment-orders-admin] list', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

paymentOrdersAdminRouter.get('/:orderId/recovery-eligibility', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const result = await getPaymentRecoveryEligibility(req.params.orderId)
    if (!result.ok) return res.status(404).json(result)
    res.json(result)
  } catch (e) {
    console.error('[payment-orders-admin] recovery-eligibility', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

paymentOrdersAdminRouter.get('/:orderId', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const detail = await getPaymentOrderDetail(req.params.orderId)
    if (!detail?.order) return res.status(404).json({ ok: false, error: 'Order not found' })
    res.json({ ok: true, ...detail })
  } catch (e) {
    console.error('[payment-orders-admin] detail', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

paymentOrdersAdminRouter.post('/:orderId/recover', async (req, res) => {
  try {
    await handleRecover(req, res)
  } catch (e) {
    console.error('[payment-orders-admin] recover', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

paymentOrdersAdminRouter.post('/:orderId/approve-recovery', async (req, res) => {
  try {
    await handleRecover(req, res)
  } catch (e) {
    console.error('[payment-orders-admin] approve-recovery', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

paymentOrdersAdminRouter.post('/:orderId/reject-recovery', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(b.pin ?? b.security_pin ?? '').trim()
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    const orderId = String(req.params.orderId ?? '').trim()
    const result = await rejectAdminPaymentRecovery({
      orderId,
      adminIdentity: adminLabel(req),
      reason: b.reason ?? '',
    })
    res.json(result)
  } catch (e) {
    console.error('[payment-orders-admin] reject-recovery', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

paymentOrdersAdminRouter.post('/:orderId/reconcile', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(b.pin ?? b.security_pin ?? '').trim()
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    const orderId = String(req.params.orderId ?? '').trim()
    const rec = await reconcilePaymentOrder(orderId)
    res.json({ ok: true, reconcile: rec })
  } catch (e) {
    console.error('[payment-orders-admin] reconcile', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
