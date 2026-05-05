import { Router } from 'express'
import * as billing from '../billingStore.js'
import { formatPhone } from '../zenopayClient.js'

export const subscriptionRouter = Router()

/** GET /subscription — query: userId | user_id, phone (digits normalized to +255…) */
subscriptionRouter.get('/', async (req, res) => {
  try {
    const userId = String(req.query.userId ?? req.query.user_id ?? '').trim()
    const rawPhone = String(req.query.phone ?? '').trim()
    const phoneNorm = rawPhone ? formatPhone(rawPhone) : ''
    const row = await billing.getSubscriptionByUserOrPhone(
      userId || null,
      phoneNorm || null,
    )
    console.log('PHONE MATCH:', { input: phoneNorm || rawPhone, db: row?.phone })
    console.log('SUB API RESULT:', row)
    if (!row) {
      return res.json({ isActive: false, expiresAt: null })
    }
    const expiresAt = row.expires_at
    const expiresAtDate = expiresAt ? new Date(expiresAt) : null
    const notExpired = Boolean(expiresAtDate && !Number.isNaN(expiresAtDate.getTime()) && expiresAtDate > new Date())
    const isActive = row.is_active === true && notExpired
    const expiresAtOut =
      expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt != null ? String(expiresAt) : null
    res.json({ isActive, expiresAt: expiresAtOut })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})
