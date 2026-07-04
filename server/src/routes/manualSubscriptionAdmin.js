import { Router } from 'express'
import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { adminSecurityPinFromBody, verifyAdminSecurityPin } from '../lib/adminSecurityPin.js'
import { verifyAdminSensitiveActionPassword } from '../lib/adminSensitiveActionPassword.js'
import { notifySubscriptionTransferred } from '../lib/subscriptionTransferNotify.js'
import { invalidateSubscriptionAccessCache } from '../lib/subscriptionAccessCache.js'
import { clearVerifyAccessInflightForDevice } from '../lib/verifyAccessSingleflight.js'

export const manualSubscriptionAdminRouter = Router()
manualSubscriptionAdminRouter.use(requireAdminPanelAccess)

/** Hourly rolling window per client IP */
const rateBucket = new Map()
/** Setup-pin attempts per IP (separate from grant limiter) */
const setupRateBucket = new Map()

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

function rateLimitSetup(req, res, next) {
  const maxPerHour = Math.min(80, Math.max(5, Number(process.env.MANUAL_PIN_SETUP_RATE_LIMIT_PER_HOUR) || 20))
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown').split(',')[0].trim()
  const now = Date.now()
  const windowMs = 60 * 60 * 1000
  const key = `setup:${ip}`
  let b = setupRateBucket.get(key)
  if (!b || now - b.start > windowMs) {
    b = { start: now, n: 0 }
  }
  b.n += 1
  setupRateBucket.set(key, b)
  if (b.n > maxPerHour) {
    console.warn('[manual_pin_setup] rate limited', { ip })
    return res.status(429).json({ ok: false, error: 'Too many setup attempts; try again later' })
  }
  next()
}

manualSubscriptionAdminRouter.get('/pin-status', async (_req, res) => {
  try {
    res.json({
      ok: true,
      configured: true,
      usesSharedActionPassword: true,
      legacyPinConfigured: await billing.isManualSubscriptionPinConfigured(),
    })
  } catch (e) {
    console.error('[manual_subscription pin-status]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.post('/setup-pin', rateLimitSetup, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(body.pin ?? '')
    const confirm = String(body.confirm_pin ?? body.confirmPin ?? '')
    if (pin !== confirm) {
      return res.status(400).json({ ok: false, error: 'PIN and confirmation do not match' })
    }
    if (pin.length < billing.MANUAL_SUBSCRIPTION_PIN_MIN_LENGTH) {
      return res.status(400).json({
        ok: false,
        error: `PIN must be at least ${billing.MANUAL_SUBSCRIPTION_PIN_MIN_LENGTH} characters`,
      })
    }
    await billing.setupManualSubscriptionPinFirstTime(pin)
    console.log(
      '[manual_pin_setup_audit]',
      JSON.stringify({
        action: 'manual_subscription_pin_setup_success',
        at: new Date().toISOString(),
      }),
    )
    res.json({ ok: true })
  } catch (e) {
    if (e?.code === 'PIN_ALREADY_CONFIGURED') {
      return res.status(409).json({ ok: false, error: 'PIN is already configured' })
    }
    if (e?.code === 'PIN_TOO_SHORT') {
      return res.status(400).json({ ok: false, error: e.message })
    }
    console.error('[manual_subscription setup-pin]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

function logManualSubscriptionAudit(action, deviceId, extra = {}) {
  console.log(
    '[manual_subscription_audit]',
    JSON.stringify({
      action,
      device_id: deviceId,
      timestamp: new Date().toISOString(),
      ...extra,
    }),
  )
}

/** Immediate SSE + cache bust after manual grant delete/revoke. */
function publishManualGrantDeletionRealtime(deviceIds, { revoked = false } = {}) {
  const reason = revoked ? 'manual_grant_revoked' : 'manual_grant_history_deleted'
  for (const raw of deviceIds) {
    const deviceId = String(raw ?? '').trim()
    if (!deviceId) continue
    invalidateSubscriptionAccessCache(deviceId)
    clearVerifyAccessInflightForDevice(deviceId)
    notifySubscriptionTransferred({
      targetDeviceId: deviceId,
      targetRow: {
        device_id: deviceId,
        status: 'pending',
        active_now: false,
      },
      reason,
    })
    deviceSubscriptionBus.emit('update', { deviceId, reason })
    liveSyncBus.publish('analytics.subscription_updated', {
      topics: ['analytics'],
      deviceId,
      orderId: reason,
    })
  }
}

function adminCreatedByLabel(req) {
  if (req?.adminAuth?.email) return String(req.adminAuth.email).trim().slice(0, 256)
  if (req?.adminAuth?.legacy) return 'legacy_token'
  return 'admin'
}

/** Safe DB routing fingerprint for logs (no credentials). */
function manualAdminDbTargetTag() {
  const u = String(process.env.DATABASE_URL || '').trim()
  if (!u) return { DATABASE_URL: 'unset' }
  try {
    const url = new URL(u)
    const dbName = String(url.pathname || '')
      .replace(/^\//, '')
      .split('/')[0]
      .split('?')[0]
    return { dbHost: url.hostname, dbPort: url.port || null, dbName: dbName || null }
  } catch {
    return { DATABASE_URL: 'unparseable' }
  }
}

manualSubscriptionAdminRouter.get('/history', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    const rows = await billing.listManualSubscriptionHistoryAdmin({ limit: 500 })
    if (billing.manualSubscriptionAdminDebugEnabled()) {
      console.info(
        '[manual_subscription_history_http]',
        JSON.stringify({
          at: new Date().toISOString(),
          dbTarget: manualAdminDbTargetTag(),
          responseRowCount: rows.length,
          idSample: rows.slice(0, 12).map((r) => r.id),
        }),
      )
    }
    res.json({ ok: true, rows })
  } catch (e) {
    console.error('[manual_subscription history]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.post('/block', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(body.device_id ?? body.deviceId ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const out = await billing.setManualAdminBlocked(deviceId, true)
    if (!out.updated) {
      return res.status(404).json({ ok: false, error: 'No subscription row for this device' })
    }
    logManualSubscriptionAudit('block', deviceId)
    deviceSubscriptionBus.emit('update', { deviceId })
    liveSyncBus.publish('analytics.subscription_updated', {
      topics: ['analytics'],
      deviceId,
      orderId: 'manual_admin_block',
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('[manual_subscription block]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.post('/unblock', async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(body.device_id ?? body.deviceId ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ ok: false, error: 'device_id is required' })
    }
    const out = await billing.setManualAdminBlocked(deviceId, false)
    if (!out.updated) {
      return res.status(404).json({ ok: false, error: 'No subscription row for this device' })
    }
    logManualSubscriptionAudit('unblock', deviceId)
    deviceSubscriptionBus.emit('update', { deviceId })
    liveSyncBus.publish('analytics.subscription_updated', {
      topics: ['analytics'],
      deviceId,
      orderId: 'manual_admin_unblock',
    })
    res.json({ ok: true })
  } catch (e) {
    console.error('[manual_subscription unblock]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.post('/bulk-block', async (req, res) => {
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const rawIds = body.device_ids ?? body.deviceIds
    const deviceIds = Array.isArray(rawIds)
      ? [...new Set(rawIds.map((x) => String(x ?? '').trim()).filter(Boolean))]
      : []
    const slice = deviceIds.slice(0, 500)
    if (slice.length === 0) {
      return res.status(400).json({ ok: false, error: 'device_ids required' })
    }
    let blocked = 0
    let notFound = 0
    for (const deviceId of slice) {
      const out = await billing.setManualAdminBlocked(deviceId, true)
      if (out.updated) {
        blocked += 1
        logManualSubscriptionAudit('bulk_block', deviceId)
        deviceSubscriptionBus.emit('update', { deviceId })
        liveSyncBus.publish('analytics.subscription_updated', {
          topics: ['analytics'],
          deviceId,
          orderId: 'manual_admin_bulk_block',
        })
      } else {
        notFound += 1
      }
    }
    res.json({ ok: true, blocked, not_found: notFound })
  } catch (e) {
    console.error('[manual_subscription bulk-block]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.post('/bulk-unblock', async (req, res) => {
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const rawIds = body.device_ids ?? body.deviceIds
    const deviceIds = Array.isArray(rawIds)
      ? [...new Set(rawIds.map((x) => String(x ?? '').trim()).filter(Boolean))]
      : []
    const slice = deviceIds.slice(0, 500)
    if (slice.length === 0) {
      return res.status(400).json({ ok: false, error: 'device_ids required' })
    }
    let unblocked = 0
    let notFound = 0
    for (const deviceId of slice) {
      const out = await billing.setManualAdminBlocked(deviceId, false)
      if (out.updated) {
        unblocked += 1
        logManualSubscriptionAudit('bulk_unblock', deviceId)
        deviceSubscriptionBus.emit('update', { deviceId })
        liveSyncBus.publish('analytics.subscription_updated', {
          topics: ['analytics'],
          deviceId,
          orderId: 'manual_admin_bulk_unblock',
        })
      } else {
        notFound += 1
      }
    }
    res.json({ ok: true, unblocked, not_found: notFound })
  } catch (e) {
    console.error('[manual_subscription bulk-unblock]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.post('/history/bulk-delete', async (req, res) => {
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const raw = body.grant_ids ?? body.grantIds
    const dbg = billing.manualSubscriptionAdminDebugEnabled()
    if (dbg) {
      console.info(
        '[manual_bulk_delete_payload]',
        JSON.stringify({
          at: new Date().toISOString(),
          dbTarget: manualAdminDbTargetTag(),
          rawIsArray: Array.isArray(raw),
          rawLen: Array.isArray(raw) ? raw.length : 0,
          rawSample: Array.isArray(raw) ? raw.slice(0, 12) : raw,
          rawTypesSample: Array.isArray(raw)
            ? raw.slice(0, 5).map((x) => (x === null || x === undefined ? String(x) : typeof x))
            : [],
        }),
      )
    }
    const slice = billing.normalizeManualGrantIdList(raw)
    if (slice.length === 0) {
      return res.status(400).json({ ok: false, error: 'grant_ids required' })
    }
    if (dbg) {
      console.info(
        '[manual_bulk_delete_normalized]',
        JSON.stringify({ at: new Date().toISOString(), count: slice.length, sample: slice.slice(0, 12) }),
      )
    }
    const { deleted, notFound, rows, deviceIds, revoked } = await billing.bulkDeleteManualGrantsWithRevoke(slice)
    for (const r of rows) {
      logManualSubscriptionAudit('bulk_delete_grant', r.deviceId, { grant_id: r.grantId, revoked: r.revoked })
    }
    publishManualGrantDeletionRealtime(deviceIds, { revoked: (revoked ?? 0) > 0 })
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    const payload = { ok: true, deleted, not_found: notFound, revoked: revoked ?? 0 }
    if (dbg) {
      console.info(
        '[manual_bulk_delete_response]',
        JSON.stringify({
          at: new Date().toISOString(),
          dbTarget: manualAdminDbTargetTag(),
          ...payload,
          returnedIdsSample: rows.slice(0, 12).map((r) => r.id),
        }),
      )
    }
    res.json(payload)
  } catch (e) {
    console.error('[manual_subscription bulk-delete]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.delete('/history/:grantId', async (req, res) => {
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }
    const grantId = Number(req.params.grantId)
    if (!Number.isFinite(grantId) || grantId < 1) {
      return res.status(400).json({ ok: false, error: 'Invalid grant id' })
    }
    const result = await billing.deleteManualGrantWithRevoke(grantId)
    if (!result.deleted) {
      return res.status(404).json({ ok: false, error: 'Grant not found or already deleted' })
    }
    logManualSubscriptionAudit('delete', result.deviceId, {
      grant_id: grantId,
      revoked: result.revoked,
    })
    publishManualGrantDeletionRealtime([result.deviceId], { revoked: result.revoked })
    res.json({ ok: true, revoked: result.revoked === true })
  } catch (e) {
    console.error('[manual_subscription delete history]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.post('/history/delete-all', async (req, res) => {
  try {
    const pin = adminSecurityPinFromBody(req)
    if (!pin) return res.status(400).json({ ok: false, error: 'security_pin required' })
    if (!verifyAdminSecurityPin(pin)) {
      return res.status(403).json({ ok: false, error: 'Security PIN si sahihi' })
    }
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    if (body.confirm !== true && String(body.confirm ?? '').toLowerCase() !== 'delete all') {
      return res.status(400).json({ ok: false, error: 'confirm: true required' })
    }
    const result = await billing.deleteAllManualGrantsWithRevoke()
    for (const deviceId of result.deviceIds) {
      logManualSubscriptionAudit('delete_all_grant', deviceId)
    }
    publishManualGrantDeletionRealtime(result.deviceIds, { revoked: result.revoked > 0 })
    res.json({
      ok: true,
      deleted: result.deleted,
      revoked: result.revoked,
      devices_notified: result.deviceIds.length,
    })
  } catch (e) {
    console.error('[manual_subscription delete-all]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

manualSubscriptionAdminRouter.post('/grant-custom', rateLimitGrant, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(body.pin ?? body.security_pin ?? '').trim()
    if (!pin) {
      return res.status(400).json({ ok: false, error: 'PIN is required' })
    }
    if (!verifyAdminSensitiveActionPassword(pin)) {
      console.warn('[manual_grant_custom] invalid sensitive-action password', {
        ip: String(req.headers['x-forwarded-for'] ?? '').slice(0, 40),
      })
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }

    const deviceId = String(body.device_id ?? body.deviceId ?? '').trim()
    const planId = Number(body.plan_id ?? body.planId)
    const startedAt = body.started_at ?? body.startedAt
    const expiresAt = body.expires_at ?? body.expiresAt
    const phone = String(body.phone ?? body.phone_number ?? body.phoneNumber ?? '').trim()
    if (!deviceId || !Number.isFinite(planId) || planId < 1 || !startedAt || !expiresAt) {
      return res.status(400).json({
        ok: false,
        error: 'device_id, plan_id, started_at, and expires_at are required',
      })
    }
    if (!phone) {
      return res.status(400).json({ ok: false, error: 'phone is required' })
    }

    const result = await billing.grantCustomManualDeviceSubscription(deviceId, {
      planId,
      startedAt,
      expiresAt,
      phone,
      createdBy: adminCreatedByLabel(req),
    })

    void recordSystemNotificationEvent('subscription_manual_grant', {
      device_id: deviceId,
      grant_id: result.grantId,
      duration_days: result.durationDays,
      custom_expiry: true,
      manual_custom: true,
    }).catch((err) => {
      console.error('[manual_grant_custom] notification sync failed:', err)
    })

    logManualSubscriptionAudit('grant_custom', deviceId, {
      grant_id: result.grantId,
      plan_id: planId,
      custom_expiry: true,
      created_by: result.createdBy,
    })

    res.json({
      ok: true,
      grantId: result.grantId,
      nonce: result.nonce,
      expiresAt: result.expiresAt,
      startedAt: result.startedAt,
      durationDays: result.durationDays,
      planId: result.planId,
      planName: result.planName,
      customExpiry: true,
      manualCustom: true,
      createdBy: result.createdBy,
    })
  } catch (e) {
    const msg = String(e?.message || e)
    if (/must be later|Invalid started_at|Invalid expires_at|Plan not found/i.test(msg)) {
      return res.status(400).json({ ok: false, error: msg })
    }
    console.error('[manual_grant_custom]', e)
    res.status(500).json({ ok: false, error: msg })
  }
})

manualSubscriptionAdminRouter.post('/grant', rateLimitGrant, async (req, res) => {
  try {
    const body = req.body && typeof req.body === 'object' ? req.body : {}
    const pin = String(body.pin ?? body.security_pin ?? '').trim()
    if (!pin) {
      return res.status(400).json({ ok: false, error: 'PIN is required' })
    }
    if (!verifyAdminSensitiveActionPassword(pin)) {
      console.warn('[manual_grant] invalid sensitive-action password', {
        ip: String(req.headers['x-forwarded-for'] ?? '').slice(0, 40),
      })
      return res.status(403).json({ ok: false, error: 'Invalid PIN' })
    }

    const deviceId = String(body.device_id ?? body.deviceId ?? '').trim()
    const durationDays = Number(body.duration_days ?? body.durationDays)
    const phone = String(body.phone ?? body.phone_number ?? body.phoneNumber ?? '').trim()
    const allowed = await billing.getManualGrantAllowedDurationDays()
    if (!deviceId || !allowed.has(durationDays)) {
      const list = [...allowed].sort((a, b) => a - b).join(', ')
      return res.status(400).json({
        ok: false,
        error: `device_id and duration_days are required (duration_days: ${list})`,
      })
    }
    if (!phone) {
      return res.status(400).json({ ok: false, error: 'phone is required' })
    }

    const result = await billing.grantManualDeviceSubscription(deviceId, durationDays, null, { phone })

    void recordSystemNotificationEvent('subscription_manual_grant', {
      device_id: deviceId,
      grant_id: result.grantId,
      duration_days: durationDays,
    }).catch((err) => {
      console.error('[manual_grant] notification sync failed:', err)
    })

    logManualSubscriptionAudit('grant', deviceId)

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
