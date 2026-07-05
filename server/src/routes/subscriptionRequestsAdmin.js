import { Router } from 'express'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { verifyAdminSensitiveActionPassword } from '../lib/adminSensitiveActionPassword.js'
import {
  listSubscriptionRequestsAdmin,
  countSubscriptionRequestsByStatus,
  approveSubscriptionRequest,
  rejectSubscriptionRequest,
  blockSubscriptionRequest,
  deleteSubscriptionRequest,
  bulkDeleteSubscriptionRequests,
} from '../lib/subscriptionRequestStore.js'
import {
  readOmbaKifurushiEnabled,
  writeOmbaKifurushiEnabled,
  publishOmbaKifurushiChanged,
  OMBA_KIFURUSHI_DISABLED_MESSAGE_SW,
} from '../lib/subscriptionRequestSettings.js'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const subscriptionRequestsAdminRouter = Router()
subscriptionRequestsAdminRouter.use(requireAdminPanelAccess)

function adminLabel(req) {
  if (req?.adminAuth?.email) return String(req.adminAuth.email).trim().slice(0, 256)
  if (req?.adminAuth?.legacy) return 'legacy_token'
  return 'admin'
}

subscriptionRequestsAdminRouter.get('/settings', async (_req, res) => {
  try {
    const enabled = await readOmbaKifurushiEnabled()
    res.json({
      ok: true,
      enabled,
      omba_kifurushi_enabled: enabled,
      disabled_message_sw: OMBA_KIFURUSHI_DISABLED_MESSAGE_SW,
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

subscriptionRequestsAdminRouter.put('/settings', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(b.pin ?? b.security_pin ?? '').trim()
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    const enabled = b.enabled === true || String(b.enabled ?? '').toLowerCase() === 'true'
    const pool = getPool()
    if (!pool) return res.status(503).json({ ok: false, error: 'Database not configured' })
    await writeOmbaKifurushiEnabled(pool, enabled, adminLabel(req))
    publishOmbaKifurushiChanged(enabled)
    res.json({ ok: true, enabled, omba_kifurushi_enabled: enabled })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

subscriptionRequestsAdminRouter.get('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const q = req.query || {}
    const [rows, statusCounts] = await Promise.all([
      listSubscriptionRequestsAdmin({
        status: q.status ?? 'all',
        search: q.search ?? q.q ?? '',
        limit: q.limit ?? 200,
      }),
      countSubscriptionRequestsByStatus(),
    ])
    res.json({
      ok: true,
      rows: rows.map(mapRequestRow),
      count: rows.length,
      statusCounts,
    })
  } catch (e) {
    console.error('[subscription-requests-admin] list', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

function mapRequestRow(r) {
  return {
    id: r.id,
    requestId: r.id,
    deviceId: r.device_id,
    phone: r.phone,
    normalizedPhone: r.normalized_phone,
    planId: r.plan_id,
    planName: r.plan_name_snapshot,
    durationDays: r.duration_days,
    price: Number(r.price_snapshot) || 0,
    status: r.status,
    appVersion: r.app_version,
    runtimeVersion: r.runtime_version,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
    adminDecisionBy: r.admin_decision_by,
    adminDecisionAt: r.admin_decision_at instanceof Date ? r.admin_decision_at.toISOString() : r.admin_decision_at,
    adminReason: r.admin_reason,
    approvedPlanId: r.approved_plan_id,
    resultingGrantId: r.resulting_grant_id,
    resultingOrderId: r.resulting_order_id,
    subscriptionExpiresAt:
      r.subscription_expires_at instanceof Date ? r.subscription_expires_at.toISOString() : r.subscription_expires_at,
    subStatus: r.sub_status,
    subExpiresAt: r.sub_expires_at instanceof Date ? r.sub_expires_at.toISOString() : r.sub_expires_at,
  }
}

subscriptionRequestsAdminRouter.post('/bulk-delete', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(b.pin ?? b.security_pin ?? '').trim()
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    const raw = b.request_ids ?? b.requestIds ?? b.ids
    const result = await bulkDeleteSubscriptionRequests({
      requestIds: raw,
      adminIdentity: adminLabel(req),
    })
    liveSyncBus.publish('subscription_request_updated', {
      topics: ['config'],
      action: 'bulk_delete',
      deleted: result.deleted,
    })
    res.json(result)
  } catch (e) {
    console.error('[subscription-requests-admin] bulk-delete', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

subscriptionRequestsAdminRouter.post('/:requestId/approve', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(b.pin ?? b.security_pin ?? '').trim()
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    if (b.confirm !== true) return res.status(400).json({ ok: false, error: 'confirm:true is required' })
    const result = await approveSubscriptionRequest({
      requestId: req.params.requestId,
      adminIdentity: adminLabel(req),
      reason: b.reason ?? '',
      editedPlanId: b.plan_id ?? b.planId ?? null,
    })
    liveSyncBus.publish('subscription_request_updated', {
      topics: ['analytics', 'config'],
      requestId: Number(req.params.requestId),
      deviceId: result.request?.device_id ?? null,
      status: 'APPROVED',
    })
    res.json({ ok: true, ...result, request: mapRequestRow(result.request) })
  } catch (e) {
    console.error('[subscription-requests-admin] approve', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

subscriptionRequestsAdminRouter.post('/:requestId/reject', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(b.pin ?? b.security_pin ?? '').trim()
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    const result = await rejectSubscriptionRequest({
      requestId: req.params.requestId,
      adminIdentity: adminLabel(req),
      reason: b.reason ?? '',
    })
    liveSyncBus.publish('subscription_request_updated', {
      topics: ['config'],
      requestId: Number(req.params.requestId),
      status: 'REJECTED',
    })
    res.json({ ok: true, ...result, request: mapRequestRow(result.request) })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

subscriptionRequestsAdminRouter.post('/:requestId/block', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(b.pin ?? b.security_pin ?? '').trim()
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    const result = await blockSubscriptionRequest({
      requestId: req.params.requestId,
      adminIdentity: adminLabel(req),
      reason: b.reason ?? '',
    })
    liveSyncBus.publish('subscription_request_updated', {
      topics: ['config'],
      requestId: Number(req.params.requestId),
      status: 'BLOCKED',
    })
    res.json({ ok: true, ...result, request: mapRequestRow(result.request) })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

subscriptionRequestsAdminRouter.post('/:requestId/delete', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(b.pin ?? b.security_pin ?? '').trim()
    if (!pin) return res.status(400).json({ ok: false, error: 'PIN is required' })
    if (!verifyAdminSensitiveActionPassword(pin)) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    const result = await deleteSubscriptionRequest({
      requestId: req.params.requestId,
      adminIdentity: adminLabel(req),
    })
    liveSyncBus.publish('subscription_request_updated', {
      topics: ['config'],
      requestId: Number(req.params.requestId),
      status: 'DELETED',
    })
    res.json({ ok: true, ...result, request: mapRequestRow(result.request) })
  } catch (e) {
    console.error('[subscription-requests-admin] delete', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
