import { Router } from 'express'
import * as billing from '../billingStore.js'

export const usersRouter = Router()

usersRouter.get('/', async (_req, res) => {
  try {
    const rows = await billing.listDeviceUsers()
    const now = Date.now()
    res.json(
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
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

usersRouter.put('/:device_id', async (req, res) => {
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
    res.json({
      device_id: String(row.device_id ?? ''),
      status: st,
      expires_at: outExp,
      started_at:
        row.started_at instanceof Date ? row.started_at.toISOString() : String(row.started_at ?? ''),
    })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

usersRouter.delete('/:device_id', async (req, res) => {
  try {
    const deviceId = String(req.params.device_id ?? '').trim()
    if (!deviceId) return res.status(400).json({ error: 'device_id is required' })
    const out = await billing.deleteDeviceUserCascade(deviceId)
    res.json({ ok: true, ...out })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})

