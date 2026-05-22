import { Router } from 'express'
import * as billing from '../billingStore.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { adminSecurityPinFromBody, verifyAdminSecurityPin } from '../lib/adminSecurityPin.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const offerCodesAdminRouter = Router()
offerCodesAdminRouter.use(requireAdminPanelAccess)

function publishOfferCodesSync(action, extra = {}) {
  liveSyncBus.publish('config.offer_codes_changed', {
    topics: ['config'],
    action,
    synced_at: new Date().toISOString(),
    ...extra,
  })
}

offerCodesAdminRouter.post('/generate', async (req, res) => {
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
    const allowed = await billing.getManualGrantAllowedDurationDays()
    if (!allowed.has(durationDays)) {
      const list = [...allowed].sort((a, b) => a - b).join(', ')
      return res.status(400).json({
        ok: false,
        error: `duration_days must be one of: ${list}`,
      })
    }
    const row = await billing.insertOfferCodeRow({ durationDays, createdBy: 'admin' })
    billing.offerCodeAudit('generated', {
      code: row.code,
      duration_days: row.duration_days,
    })
    const exp = row.expires_at
    publishOfferCodesSync('generated', { code: String(row.code) })
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

offerCodesAdminRouter.get('/history', async (_req, res) => {
  try {
    const rows = await billing.listOfferCodesHistoryAdmin({ limit: 500 })
    res.json({ ok: true, rows })
  } catch (e) {
    console.error('[offer-codes history]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.post('/bulk-block', async (req, res) => {
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const raw = body.codes
    const codes = Array.isArray(raw)
      ? [...new Set(raw.map((c) => billing.normalizeOfferCode(String(c ?? '').trim())).filter(Boolean))]
      : []
    const slice = codes.slice(0, 500)
    if (slice.length === 0) return res.status(400).json({ ok: false, error: 'codes required' })
    let blocked = 0
    let notFound = 0
    for (const code of slice) {
      const okRow = await billing.setOfferCodeBlockedByCode(code, true)
      if (okRow) {
        blocked += 1
        billing.offerCodeAudit('bulk_blocked', { code: billing.normalizeOfferCode(code) })
      } else {
        notFound += 1
      }
    }
    publishOfferCodesSync('bulk_blocked', { blocked, not_found: notFound })
    res.json({ ok: true, blocked, not_found: notFound })
  } catch (e) {
    console.error('[offer-codes bulk-block]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.post('/bulk-unblock', async (req, res) => {
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const raw = body.codes
    const codes = Array.isArray(raw)
      ? [...new Set(raw.map((c) => billing.normalizeOfferCode(String(c ?? '').trim())).filter(Boolean))]
      : []
    const slice = codes.slice(0, 500)
    if (slice.length === 0) return res.status(400).json({ ok: false, error: 'codes required' })
    let unblocked = 0
    let notFound = 0
    for (const code of slice) {
      const okRow = await billing.setOfferCodeBlockedByCode(code, false)
      if (okRow) {
        unblocked += 1
        billing.offerCodeAudit('bulk_unblocked', { code: billing.normalizeOfferCode(code) })
      } else {
        notFound += 1
      }
    }
    publishOfferCodesSync('bulk_unblocked', { unblocked, not_found: notFound })
    res.json({ ok: true, unblocked, not_found: notFound })
  } catch (e) {
    console.error('[offer-codes bulk-unblock]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.post('/bulk-delete', async (req, res) => {
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const raw = body.codes
    const codes = Array.isArray(raw)
      ? [...new Set(raw.map((c) => billing.normalizeOfferCode(String(c ?? '').trim())).filter(Boolean))]
      : []
    const slice = codes.slice(0, 500)
    if (slice.length === 0) return res.status(400).json({ ok: false, error: 'codes required' })
    let deleted = 0
    let notFound = 0
    for (const code of slice) {
      const okRow = await billing.softDeleteOfferCodeByCode(code)
      if (okRow) {
        deleted += 1
        billing.offerCodeAudit('bulk_deleted', { code: billing.normalizeOfferCode(code) })
      } else {
        notFound += 1
      }
    }
    publishOfferCodesSync('bulk_deleted', { deleted, not_found: notFound })
    res.json({ ok: true, deleted, not_found: notFound })
  } catch (e) {
    console.error('[offer-codes bulk-delete]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.post('/block', async (req, res) => {
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
    publishOfferCodesSync('blocked', { code: billing.normalizeOfferCode(raw) })
    res.json({ ok: true })
  } catch (e) {
    console.error('[offer-codes block]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.post('/unblock', async (req, res) => {
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
    publishOfferCodesSync('unblocked', { code: billing.normalizeOfferCode(raw) })
    res.json({ ok: true })
  } catch (e) {
    console.error('[offer-codes unblock]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

offerCodesAdminRouter.delete('/:code', async (req, res) => {
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
    publishOfferCodesSync('deleted', { code: billing.normalizeOfferCode(raw) })
    res.json({ ok: true })
  } catch (e) {
    console.error('[offer-codes delete]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
