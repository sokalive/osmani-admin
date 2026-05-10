import { Router } from 'express'
import * as billing from '../billingStore.js'

export const offerCodesAdminRouter = Router()

const ALLOWED_DURATIONS = new Set([1, 7, 30, 90])

function requireAdminToken(req, res, next) {
  const expected = String(process.env.APP_UPDATE_ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '').trim()
  if (!expected) {
    return res.status(503).json({ ok: false, error: 'ADMIN_API_TOKEN / APP_UPDATE_ADMIN_TOKEN is not configured' })
  }
  const got = String(req.headers['x-admin-token'] ?? '').trim()
  if (got !== expected) {
    return res.status(403).json({ ok: false, error: 'Invalid admin token' })
  }
  next()
}

offerCodesAdminRouter.post('/generate', requireAdminToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(body.pin ?? '').trim()
    if (!pin) {
      return res.status(400).json({ ok: false, error: 'PIN is required' })
    }
    if (!(await billing.verifyManualSubscriptionGrantPin(pin))) {
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }
    const durationDays = Number(body.duration_days ?? body.durationDays)
    if (!ALLOWED_DURATIONS.has(durationDays)) {
      return res.status(400).json({
        ok: false,
        error: 'duration_days must be one of 1, 7, 30, 90',
      })
    }
    const row = await billing.insertOfferCodeRow({ durationDays, createdBy: 'admin' })
    billing.offerCodeAudit('generated', {
      code: row.code,
      duration_days: row.duration_days,
    })
    const exp = row.expires_at
    res.json({
      ok: true,
      code: String(row.code),
      durationDays: Number(row.duration_days),
      id: Number(row.id),
      expiresAt: exp instanceof Date ? exp.toISOString() : exp != null ? String(exp) : null,
    })
  } catch (e) {
    console.error('[offer-codes generate]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.get('/history', requireAdminToken, async (_req, res) => {
  try {
    const rows = await billing.listOfferCodesHistoryAdmin({ limit: 500 })
    res.json({ ok: true, rows })
  } catch (e) {
    console.error('[offer-codes history]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.post('/block', requireAdminToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const raw = String(body.code ?? '').trim()
    if (!raw) {
      return res.status(400).json({ ok: false, error: 'code is required' })
    }
    const ok = await billing.setOfferCodeBlockedByCode(raw, true)
    if (!ok) {
      return res.status(404).json({ ok: false, error: 'Code not found or deleted' })
    }
    billing.offerCodeAudit('blocked', { code: billing.normalizeOfferCode(raw) })
    res.json({ ok: true })
  } catch (e) {
    console.error('[offer-codes block]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.post('/unblock', requireAdminToken, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const raw = String(body.code ?? '').trim()
    if (!raw) {
      return res.status(400).json({ ok: false, error: 'code is required' })
    }
    const ok = await billing.setOfferCodeBlockedByCode(raw, false)
    if (!ok) {
      return res.status(404).json({ ok: false, error: 'Code not found or deleted' })
    }
    billing.offerCodeAudit('unblocked', { code: billing.normalizeOfferCode(raw) })
    res.json({ ok: true })
  } catch (e) {
    console.error('[offer-codes unblock]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.delete('/:code', requireAdminToken, async (req, res) => {
  try {
    const raw = String(req.params.code ?? '').trim()
    if (!raw) {
      return res.status(400).json({ ok: false, error: 'code is required' })
    }
    const ok = await billing.softDeleteOfferCodeByCode(raw)
    if (!ok) {
      return res.status(404).json({ ok: false, error: 'Code not found or already deleted' })
    }
    billing.offerCodeAudit('deleted', { code: billing.normalizeOfferCode(raw) })
    res.json({ ok: true })
  } catch (e) {
    console.error('[offer-codes delete]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
