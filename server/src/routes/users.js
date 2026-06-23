import { Router } from 'express'
import * as billing from '../billingStore.js'
import {
  getAdminUsersSummary,
  listAdminActivePaidUsers,
  listAdminAllSubscriptions,
  listAdminExpiringSoonUsers,
  listAdminFailedPayments,
} from '../lib/adminUsersList.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

export const usersRouter = Router()

function notifyDeviceSubscription(deviceId, orderId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return
  deviceSubscriptionBus.emit('update', { deviceId: d })
  liveSyncBus.publish('analytics.subscription_updated', {
    topics: ['analytics'],
    deviceId: d,
    orderId: String(orderId ?? 'admin_users_sync'),
  })
}

function parseListQuery(req) {
  return {
    page: req.query.page,
    limit: req.query.limit,
    search: String(req.query.search ?? req.query.q ?? '').trim(),
    sort: String(req.query.sort ?? 'newest').trim(),
    planId: req.query.plan_id ?? req.query.planId ?? 'all',
    provider: String(req.query.provider ?? 'all').trim().toLowerCase(),
    status: String(req.query.status ?? 'all').trim().toLowerCase(),
    within: String(req.query.within ?? '7d').trim(),
  }
}

usersRouter.get('/summary', requireAdminPanelAccess, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const summary = await getAdminUsersSummary()
    res.json({ ok: true, summary })
  } catch (e) {
    console.error('[users] GET /summary failed:', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersRouter.get('/active', requireAdminPanelAccess, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const out = await listAdminActivePaidUsers(parseListQuery(req))
    res.json({ ok: true, ...out })
  } catch (e) {
    console.error('[users] GET /active failed:', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersRouter.get('/expiring', requireAdminPanelAccess, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const out = await listAdminExpiringSoonUsers(parseListQuery(req))
    res.json({ ok: true, ...out })
  } catch (e) {
    console.error('[users] GET /expiring failed:', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersRouter.get('/failed-payments', requireAdminPanelAccess, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const out = await listAdminFailedPayments(parseListQuery(req))
    res.json({ ok: true, ...out })
  } catch (e) {
    console.error('[users] GET /failed-payments failed:', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersRouter.get('/', requireAdminPanelAccess, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    if (String(req.query.legacy ?? '') === '1') {
      const rows = await billing.listDeviceUsers()
      const now = Date.now()
      return res.json(
        rows.map((r) => {
          const exp = r.expires_at instanceof Date ? r.expires_at : new Date(String(r.expires_at))
          const expiresAt = exp instanceof Date && !Number.isNaN(exp.getTime()) ? exp.toISOString() : null
          const startedAtDate =
            r.started_at instanceof Date ? r.started_at : new Date(String(r.started_at))
          const startedAt =
            startedAtDate instanceof Date && !Number.isNaN(startedAtDate.getTime())
              ? startedAtDate.toISOString()
              : null
          const remainingMs =
            expiresAt != null ? Math.max(0, new Date(expiresAt).getTime() - now) : 0
          const active =
            r.status === 'active' && expiresAt != null && new Date(expiresAt).getTime() > now
          return {
            device_id: String(r.device_id ?? ''),
            phone_number: String(r.phone_number ?? ''),
            plan_id: r.plan_id != null ? Number(r.plan_id) : null,
            status: active ? 'active' : 'expired',
            started_at: startedAt,
            expires_at: expiresAt,
            remaining: remainingMs,
          }
        }),
      )
    }
    const out = await listAdminAllSubscriptions(parseListQuery(req))
    res.json({ ok: true, ...out })
  } catch (e) {
    console.error('[users] GET / failed:', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

usersRouter.put('/:device_id', requireAdminPanelAccess, async (req, res) => {
  try {
    const deviceId = String(req.params.device_id ?? '').trim()
    if (!deviceId) return res.status(400).json({ error: 'device_id is required' })
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const expiresAt = b.expires_at != null ? String(b.expires_at).trim() : null
    const statusRaw = String(b.status ?? '').toLowerCase()
    if (!['active', 'expired'].includes(statusRaw)) {
      return res.status(400).json({ error: 'status must be active or expired' })
    }
    const row = await billing.updateDeviceSubscriptionByDeviceId(deviceId, {
      expiresAt,
      status: statusRaw,
    })
    if (!row) return res.status(404).json({ error: 'Device subscription not found' })
    const exp = row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at))
    const outExp = exp instanceof Date && !Number.isNaN(exp.getTime()) ? exp.toISOString() : null
    const st = row.status === 'active' && outExp && new Date(outExp).getTime() > Date.now() ? 'active' : 'expired'
    notifyDeviceSubscription(deviceId, 'admin_users_put')
    res.json({
      device_id: String(row.device_id ?? ''),
      status: st,
      expires_at: outExp,
      started_at:
        row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at ?? ''),
    })
  } catch (e) {
    console.error('[users] PUT /:device_id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

usersRouter.delete('/bulk', requireAdminPanelAccess, async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceIds = Array.isArray(b.device_ids)
      ? b.device_ids.map((id) => String(id ?? '').trim()).filter(Boolean)
      : []
    if (deviceIds.length === 0) {
      return res.status(400).json({ error: 'device_ids array is required', deleted: 0, skipped: 0 })
    }
    const force = b.force === true
    let deleted = 0
    let skipped = 0
    const errors = []
    for (const deviceId of deviceIds) {
      const row = await billing.getDeviceSubscriptionByDeviceId(deviceId)
      if (!row) {
        skipped += 1
        continue
      }
      const exp = row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at))
      const activeNow =
        row.status === 'active' &&
        exp instanceof Date &&
        !Number.isNaN(exp.getTime()) &&
        exp > new Date()
      if (activeNow && !force) {
        skipped += 1
        errors.push({ device_id: deviceId, error: 'active_without_force' })
        continue
      }
      await billing.deleteDeviceUserCascade(deviceId)
      notifyDeviceSubscription(deviceId, 'admin_users_bulk_delete')
      deleted += 1
    }
    res.json({ ok: true, deleted, skipped, errors })
  } catch (e) {
    console.error('[users] DELETE /bulk failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

usersRouter.delete('/:device_id', requireAdminPanelAccess, async (req, res) => {
  try {
    const deviceId = String(req.params.device_id ?? '').trim()
    if (!deviceId) {
      return res.status(404).json({
        error: 'Device subscription not found',
        deletedSubscription: 0,
        deletedTransactions: 0,
      })
    }
    const force = String(req.query.force ?? '').toLowerCase() === 'true'
    const row = await billing.getDeviceSubscriptionByDeviceId(deviceId)
    if (!row) {
      return res.status(404).json({
        error: 'Device subscription not found',
        deletedSubscription: 0,
        deletedTransactions: 0,
      })
    }
    const exp = row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at))
    const activeNow =
      row.status === 'active' && exp instanceof Date && !Number.isNaN(exp.getTime()) && exp > new Date()
    if (activeNow && !force) {
      return res.status(400).json({
        error: 'Cannot delete active user without force=true',
        deletedSubscription: 0,
        deletedTransactions: 0,
      })
    }
    const out = await billing.deleteDeviceUserCascade(deviceId)
    notifyDeviceSubscription(deviceId, 'admin_users_delete')
    res.json({ ok: true, ...out })
  } catch (e) {
    console.error('[users] DELETE /:device_id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
