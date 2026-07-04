import { Router } from 'express'
import { createSubscriptionRequest, getSubscriptionRequestForDevice } from '../lib/subscriptionRequestStore.js'
import { loadOmbaKifurushiPublicPayload } from '../lib/subscriptionRequestSettings.js'

export const subscriptionRequestsPublicRouter = Router()

/** GET /subscription-request/settings — app feature flag (no auth). */
subscriptionRequestsPublicRouter.get('/settings', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private')
    const payload = await loadOmbaKifurushiPublicPayload()
    res.json(payload)
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** POST /subscription-request — user "OMBA KIFURUSHI CHAKO" submission. */
subscriptionRequestsPublicRouter.post('/', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(b.device_id ?? b.deviceId ?? '').trim()
    const phone = String(b.phone ?? b.phone_number ?? '').trim()
    const planId = Number(b.plan_id ?? b.planId)
    if (!deviceId || !phone || !Number.isFinite(planId)) {
      return res.status(400).json({ ok: false, error: 'device_id, phone, and plan_id are required' })
    }
    const row = await createSubscriptionRequest({
      deviceId,
      phone,
      planId,
      appVersion: b.app_version ?? b.appVersion ?? null,
      runtimeVersion: b.runtime_version ?? b.runtimeVersion ?? null,
      metadata: {
        client_version_code: b.client_version_code ?? b.clientVersionCode ?? null,
        source: 'omba_kifurushi_chako',
      },
    })
    res.status(201).json({
      ok: true,
      requestId: row.id,
      status: row.status,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    })
  } catch (e) {
    const status = Number(e.status) || (e.code === 'DUPLICATE_PENDING_REQUEST' ? 409 : e.code === 'OMBA_KIFURUSHI_DISABLED' ? 403 : 500)
    res.status(status).json({
      ok: false,
      error: String(e.message || e),
      code: e.code ?? null,
    })
  }
})

/** GET /subscription-request/status?device_id= — latest requests for device. */
subscriptionRequestsPublicRouter.get('/status', async (req, res) => {
  try {
    const deviceId = String(req.query.device_id ?? req.query.deviceId ?? '').trim()
    if (!deviceId) return res.status(400).json({ ok: false, error: 'device_id is required' })
    const rows = await getSubscriptionRequestForDevice(deviceId)
    res.json({
      ok: true,
      requests: (rows ?? []).map((r) => ({
        id: r.id,
        status: r.status,
        planName: r.plan_name_snapshot,
        createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
        adminReason: r.admin_reason,
      })),
    })
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
