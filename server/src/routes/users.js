import { Router } from 'express'
import * as billing from '../billingStore.js'
import { getPool } from '../db/pool.js'
import {
  getAdminUsersSummary,
  listAdminActivePaidUsers,
  listAdminAllSubscriptions,
  listAdminExpiringSoonUsers,
  listAdminFailedPayments,
} from '../lib/adminUsersList.js'
import { lookupAdminUserHistory } from '../lib/adminUserLookup.js'
import {
  insertAdminRevocationAudit,
  notifyAdminSubscriptionRevoked,
  revokeAdminDeviceSubscription,
} from '../lib/adminSubscriptionRevocation.js'
import { invalidateSubscriptionAccessCache } from '../lib/subscriptionAccessCache.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'

export const usersRouter = Router()

function notifySubscriptionRevoked(deviceId, orderId = 'admin_revoke') {
  notifyAdminSubscriptionRevoked(deviceId, orderId)
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

function wantsPaginatedUsersList(req) {
  if (String(req.query.legacy ?? '') === '1') return false
  if (String(req.query.format ?? '') === 'paginated') return true
  return req.query.page != null || req.query.limit != null
}

function mapLegacyDeviceUsers(rows) {
  const now = Date.now()
  return rows.map((r) => {
    const exp = r.expires_at instanceof Date ? r.expires_at : new Date(String(r.expires_at))
    const expiresAt = exp instanceof Date && !Number.isNaN(exp.getTime()) ? exp.toISOString() : null
    const startedAtDate = r.started_at instanceof Date ? r.started_at : new Date(String(r.started_at))
    const startedAt =
      startedAtDate instanceof Date && !Number.isNaN(startedAtDate.getTime())
        ? startedAtDate.toISOString()
        : null
    const remainingMs = expiresAt != null ? Math.max(0, new Date(expiresAt).getTime() - now) : 0
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
  })
}

async function runRevokeForDevice(deviceId, { adminIdentity = 'admin', reason = '' } = {}) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const result = await revokeAdminDeviceSubscription({
      deviceId,
      adminIdentity,
      reason,
      client,
    })
    if (result.ok && result.revoked) {
      await insertAdminRevocationAudit(client, {
        deviceId,
        adminIdentity,
        reason,
        transactionId: result.transaction_id,
      })
    }
    await client.query('COMMIT')
    if (result.ok) notifySubscriptionRevoked(deviceId, result.transaction_id)
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
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

/** Aggregated identity history for exact device ID or normalized phone (one response). */
usersRouter.get('/lookup', requireAdminPanelAccess, async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const q = String(req.query.q ?? req.query.search ?? '').trim()
    if (!q) {
      return res.status(400).json({ ok: false, error: 'q is required' })
    }
    const out = await lookupAdminUserHistory(q)
    if (!out) {
      return res.json({ ok: true, found: false, query: q, devices: [] })
    }
    res.json({ ok: true, found: true, ...out })
  } catch (e) {
    console.error('[users] GET /lookup failed:', e)
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
    if (!wantsPaginatedUsersList(req)) {
      const rows = await billing.listDeviceUsers()
      return res.json(mapLegacyDeviceUsers(rows))
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
    invalidateSubscriptionAccessCache(deviceId)
    const exp = row.expires_at instanceof Date ? row.expires_at : new Date(String(row.expires_at))
    const outExp = exp instanceof Date && !Number.isNaN(exp.getTime()) ? exp.toISOString() : null
    const st = row.status === 'active' && outExp && new Date(outExp).getTime() > Date.now() ? 'active' : 'expired'
    notifySubscriptionRevoked(deviceId, 'admin_users_put')
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

usersRouter.post('/:device_id/revoke', requireAdminPanelAccess, async (req, res) => {
  try {
    const deviceId = String(req.params.device_id ?? '').trim()
    if (!deviceId) return res.status(400).json({ error: 'device_id is required' })
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const result = await runRevokeForDevice(deviceId, {
      adminIdentity: String(b.admin_identity ?? 'admin'),
      reason: String(b.reason ?? 'admin_users_revoke'),
    })
    if (result.notFound) return res.status(404).json({ error: 'Subscription not found' })
    res.json({
      ok: true,
      revoked: result.revoked === true,
      idempotent: result.idempotent === true,
      alreadyRevoked: result.alreadyRevoked === true,
      device_id: deviceId,
      transaction_preserved: true,
    })
  } catch (e) {
    console.error('[users] POST /:device_id/revoke failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

usersRouter.post('/bulk-revoke', requireAdminPanelAccess, async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceIds = Array.isArray(b.device_ids)
      ? b.device_ids.map((id) => String(id ?? '').trim()).filter(Boolean)
      : []
    if (deviceIds.length === 0) {
      return res.status(400).json({ error: 'device_ids array is required', revoked: 0, skipped: 0 })
    }
    let revoked = 0
    let skipped = 0
    const errors = []
    for (const deviceId of deviceIds) {
      try {
        const result = await runRevokeForDevice(deviceId, {
          reason: String(b.reason ?? 'admin_users_bulk_revoke'),
        })
        if (result.notFound) {
          skipped += 1
          continue
        }
        if (result.revoked || result.alreadyRevoked) revoked += 1
        else skipped += 1
      } catch (e) {
        errors.push({ device_id: deviceId, error: String(e.message || e) })
        skipped += 1
      }
    }
    res.json({ ok: true, revoked, skipped, errors })
  } catch (e) {
    console.error('[users] POST /bulk-revoke failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** Legacy DELETE — now revokes subscription only; payment transactions are preserved. */
usersRouter.delete('/bulk', requireAdminPanelAccess, async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceIds = Array.isArray(b.device_ids)
      ? b.device_ids.map((id) => String(id ?? '').trim()).filter(Boolean)
      : []
    if (deviceIds.length === 0) {
      return res.status(400).json({ error: 'device_ids array is required', revoked: 0, skipped: 0 })
    }
    let revoked = 0
    let skipped = 0
    for (const deviceId of deviceIds) {
      const result = await runRevokeForDevice(deviceId, { reason: 'admin_users_bulk_delete_legacy' })
      if (result.notFound) {
        skipped += 1
        continue
      }
      if (result.revoked || result.alreadyRevoked) revoked += 1
      else skipped += 1
    }
    res.json({ ok: true, revoked, skipped, deleted: revoked, transactions_preserved: true })
  } catch (e) {
    console.error('[users] DELETE /bulk failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

usersRouter.delete('/:device_id', requireAdminPanelAccess, async (req, res) => {
  try {
    const deviceId = String(req.params.device_id ?? '').trim()
    if (!deviceId) {
      return res.status(404).json({ error: 'Device subscription not found', revoked: false })
    }
    const result = await runRevokeForDevice(deviceId, { reason: 'admin_users_delete_legacy' })
    if (result.notFound) {
      return res.status(404).json({ error: 'Device subscription not found', revoked: false })
    }
    res.json({
      ok: true,
      revoked: result.revoked === true || result.alreadyRevoked === true,
      idempotent: result.idempotent === true,
      transactions_preserved: true,
      deletedSubscription: 0,
      deletedTransactions: 0,
    })
  } catch (e) {
    console.error('[users] DELETE /:device_id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
