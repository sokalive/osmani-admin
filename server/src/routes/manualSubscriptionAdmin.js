import crypto from 'node:crypto'
import { Router } from 'express'
import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const manualSubscriptionAdminRouter = Router()

const ALLOWED_DURATIONS = new Set([1, 7, 30, 90])

/** Hourly rolling window per client IP */
const rateBucket = new Map()

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

function adminPinOk(submitted) {
  const pinEnv = process.env.MANUAL_SUBSCRIPTION_ADMIN_PIN
  if (pinEnv == null || String(pinEnv).length < 4) return false
  const a = crypto.createHash('sha256').update(String(submitted), 'utf8').digest()
  const b = crypto.createHash('sha256').update(String(pinEnv), 'utf8').digest()
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function rateLimitGrant(req, res, next) {
  const maxPerHour = Math.min(200, Math.max(5, Number(process.env.MANUAL_GRANT_RATE_LIMIT_PER_HOUR) || 30))
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim()
  const now = Date.now()
  const windowMs = 60 * 60 * 1000
  let b = rateBucket.get(ip)
  if (!b || now - b.start > windowMs) {
    b = { start: now, n: 0 }
  }
  b.n += 1
  rateBucket.set(ip, b)
  if (b.n > maxPerHour) {
    console.warn('[manual_grant] rate limited', { ip })
    return res.status(429).json({ ok: false, error: 'Too many manual grant attempts; try again later' })
  }
  next()
}

manualSubscriptionAdminRouter.post('/grant', requireAdminToken, rateLimitGrant, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(body.pin ?? '')
    if (!adminPinOk(pin)) {
      console.warn('[manual_grant] invalid PIN', {
        ip: String(req.headers['x-forwarded-for'] ?? '').slice(0, 40),
      })
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }

    const deviceId = String(body.device_id ?? body.deviceId ?? '').trim()
    const durationDays = Number(body.duration_days ?? body.durationDays)
    if (!deviceId || !ALLOWED_DURATIONS.has(durationDays)) {
      return res.status(400).json({
        ok: false,
        error: 'device_id and duration_days are required (duration_days: 1 | 7 | 30 | 90)',
      })
    }

    const result = await billing.grantManualDeviceSubscription(deviceId, durationDays)

    deviceSubscriptionBus.emit('update', { deviceId })
    liveSyncBus.publish('analytics.subscription_updated', {
      topics: ['analytics'],
      deviceId,
      orderId: `manual_grant:${result.grantId}`,
    })

    console.log(
      '[manual_grant_audit]',
      JSON.stringify({
        action: 'manual_subscription_grant',
        device_id: deviceId,
        duration_days: durationDays,
        grant_id: result.grantId,
        expires_at: result.expiresAt,
        at: new Date().toISOString(),
      }),
    )

    if (process.env.MANUAL_SUBSCRIPTION_DEBUG === '1') {
      console.log('[manual_grant_debug]', {
        grantId: result.grantId,
        nonce: result.nonce,
        expiresAt: result.expiresAt,
        stackedFrom: result.stackedFromExpiresAt,
      })
    }

    res.json({
      ok: true,
      grantId: result.grantId,
      nonce: result.nonce,
      expiresAt: result.expiresAt,
      durationDays: result.durationDays,
    })
  } catch (e) {
    console.error('[manual_grant]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})
