import { Router } from 'express'
import * as billing from '../billingStore.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'

export const subscriptionRouter = Router()

const MODE_SSE_POLL_MS = Math.min(60_000, Math.max(1500, Number(process.env.MODE_SSE_POLL_MS) || 2500))

function countryFromRequest(req) {
  const raw =
    req.headers['cf-ipcountry'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-country-code'] ||
    ''
  const c = String(raw ?? '').trim().toUpperCase()
  if (!c || c.length < 2) return null
  return c.slice(0, 2)
}

function shortRef(id, n = 14) {
  const s = String(id ?? '')
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

async function reconcileOrdersForVerify(deviceId, orderIdHint) {
  const d = String(deviceId ?? '').trim()
  const hint = String(orderIdHint ?? '').trim()

  async function guardedReconcile(orderId) {
    const t = await billing.getTransactionByOrderId(orderId)
    if (!t) return
    let txnDev = String(t.device_id ?? '').trim()
    const raw = t.raw_payload && typeof t.raw_payload === 'object' ? t.raw_payload : {}
    if (!txnDev) txnDev = String(raw.device_id ?? '').trim()
    if (txnDev && txnDev !== d) {
      console.warn('[subscription-verify] order_id / device_id mismatch — skipping reconcile', {
        orderId: shortRef(orderId),
        queryDevice: shortRef(d),
        txnDevice: shortRef(txnDev),
      })
      return
    }
    await reconcileOrderWithZenoPay(orderId)
  }

  if (hint) {
    await guardedReconcile(hint)
  } else {
    const pend = await billing.getLatestPendingTransactionForDevice(d)
    if (pend?.order_id) await reconcileOrderWithZenoPay(String(pend.order_id))
  }

  const fin = await billing.tryFinalizeActivationForDevice(d)
  if (fin.ran === true && fin.activated === true && fin.deviceId) {
    deviceSubscriptionBus.emit('update', { deviceId: fin.deviceId })
    liveSyncBus.publish('analytics.subscription_updated', {
      topics: ['analytics'],
      deviceId: fin.deviceId,
      orderId: fin.orderId ?? null,
    })
    console.log('[subscription-verify] finalize activation repair', {
      deviceId: shortRef(fin.deviceId),
      orderId: shortRef(fin.orderId),
      reason: fin.reason,
    })
  }
}

function rowToPublicStatus(row) {
  if (!row) return { active: false, status: null, expiresAt: null }
  const active = row.active_now === true && row.blocked_now !== true
  const status =
    row.blocked_now === true ? 'blocked' : active ? 'active' : row.status === 'active' ? 'expired' : row.status
  const exp = row.expires_at
  const expiresAt = exp instanceof Date ? exp.toISOString() : exp != null ? String(exp) : null
  return {
    active,
    /** legacy alias used by RN clients */
    isActive: active,
    status,
    expiresAt,
    blocked: row.blocked_now === true,
    blockReason: row.block_reason ? String(row.block_reason) : null,
  }
}

/**
 * Stable verify payload for mobile Account screen + normalizeVerifyResponse consumers:
 * includes camelCase (expiresAt) and snake_case (expires_at, plan_duration_days) mirrors.
 */
function coercePlanDurationDays(txnSummary) {
  if (txnSummary == null) return null
  const v = txnSummary.plan_duration_days
  if (v === undefined || v === null) return null
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0) return null
  return Math.trunc(n)
}

export function normalizeVerifyResponse(pub, txnSummary) {
  const expiresAt = pub.expiresAt ?? null
  const amount =
    txnSummary != null && txnSummary.amount != null ? Number(txnSummary.amount) : null
  const currency =
    txnSummary != null && txnSummary.currency != null
      ? String(txnSummary.currency).trim() || null
      : null
  const planDurationDays = coercePlanDurationDays(txnSummary)

  if (process.env.SUBSCRIPTION_VERIFY_DEBUG === '1') {
    console.log('[subscription_duration_normalized]', {
      txnSummaryPlanDurationRaw: txnSummary?.plan_duration_days,
      normalizedPlanDurationDays: planDurationDays,
    })
  }

  return {
    ...pub,
    expires_at: expiresAt,
    amount,
    currency,
    plan_duration_days: planDurationDays,
    planDurationDays: planDurationDays,
  }
}

/**
 * Shared path for GET /subscription-status and POST /subscription/verify:
 * presence touch, reconcile + activate, then access state + plans.
 */
async function executeSubscriptionVerify(req, { deviceId, orderIdHint, fingerprint }) {
  const country = countryFromRequest(req)
  const d = String(deviceId ?? '').trim()
  const hint = String(orderIdHint ?? '').trim()
  const fp = String(fingerprint ?? '').trim()

  await billing.touchLivePresence({ deviceId: d, country }).catch((e) => {
    console.error('[subscription-verify] touchLivePresence failed:', e)
  })
  liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId: d })

  await reconcileOrdersForVerify(d, hint)

  const row = await billing.getDeviceSubscriptionAccessState(d, fp)
  const pub = rowToPublicStatus(row)
  const txnSummary = await billing.getLatestCompletedSubscriptionTxnSummary(d)
  const normalized = normalizeVerifyResponse(pub, txnSummary)

  if (process.env.SUBSCRIPTION_VERIFY_DEBUG === '1') {
    console.log('[subscription_verify_debug]', {
      deviceId: shortRef(d),
      verifyPayload: {
        active: normalized.active,
        expiresAt: normalized.expiresAt ? shortRef(normalized.expiresAt, 28) : null,
        expires_at: normalized.expires_at ? shortRef(normalized.expires_at, 28) : null,
      },
      txnSummary,
      normalizedSubscription: {
        amount: normalized.amount,
        currency: normalized.currency,
        plan_duration_days: normalized.plan_duration_days,
        planDurationDays: normalized.planDurationDays,
      },
    })
  }

  const pendingGift = await billing.getOldestPendingManualGrant(d)
  const manualGift =
    pendingGift != null
      ? {
          showPopup: true,
          nonce: String(pendingGift.nonce),
          grantId: Number(pendingGift.id),
          durationDays: Number(pendingGift.duration_days),
          title: 'Hongera!',
          body:
            'Umepokea kifurushi cha ofa kutoka kwa muhudumu wetu. Sasa unaweza kutazama channel zote kuanzia sasa.',
          ctaLabel: 'ASANTE',
        }
      : null

  const withGift = { ...normalized, manualGift }

  if (!pub.active) {
    const plans = await billing.listPlansWithSubscriberCounts().catch(() => [])
    return {
      ...withGift,
      playbackAllowed: false,
      plans: Array.isArray(plans)
        ? plans.map((p) => ({
            id: Number(p.id),
            name: String(p.name ?? ''),
            price: Number(p.price) || 0,
            duration_days: Number(p.duration_days) || 0,
          }))
        : [],
    }
  }
  return { ...withGift, playbackAllowed: true }
}

/**
 * POST /api/subscription/acknowledge-manual-gift
 * Body: { device_id, manual_gift_ack_key } — ack key is the grant nonce from verify `manualGift`.
 * Legacy: nonce, manualGiftAckKey (camelCase).
 */
async function handleAcknowledgeManualGift(req, res) {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(b.device_id ?? b.deviceId ?? '').trim()
    const ackKey = String(
      b.manual_gift_ack_key ?? b.manualGiftAckKey ?? b.nonce ?? b.manual_gift_nonce ?? '',
    ).trim()
    if (!deviceId || !ackKey) {
      return res.status(400).json({
        ok: false,
        error: 'device_id and manual_gift_ack_key are required',
      })
    }
    const ok = await billing.acknowledgeManualGrantFlexible(deviceId, ackKey)
    if (process.env.MANUAL_SUBSCRIPTION_DEBUG === '1') {
      console.log('[manual_gift_ack]', { deviceId: shortRef(deviceId), ok })
    }
    if (!ok) {
      return res.status(404).json({ ok: false, error: 'No pending manual gift matched' })
    }
    res.json({ ok: true })
  } catch (e) {
    console.error('[acknowledge-manual-gift]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
}

subscriptionRouter.post('/subscription/acknowledge-manual-gift', handleAcknowledgeManualGift)
/** @deprecated Prefer POST /subscription/acknowledge-manual-gift */
subscriptionRouter.post('/acknowledge-manual-gift', handleAcknowledgeManualGift)

function manualGiftPayloadFromGrant(grant) {
  if (!grant) return null
  return {
    showPopup: true,
    nonce: String(grant.nonce),
    grantId: Number(grant.grantId),
    durationDays: Number(grant.durationDays),
    title: 'Hongera!',
    body:
      'Umepokea kifurushi cha ofa kutoka kwa muhudumu wetu. Sasa unaweza kutazama channel zote kuanzia sasa.',
    ctaLabel: 'ASANTE',
  }
}

/**
 * POST /api/subscription/redeem-offer-code — applies stacked manual subscription + popup gift (same engine as admin manual grant).
 */
subscriptionRouter.post('/subscription/redeem-offer-code', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(b.device_id ?? b.deviceId ?? '').trim()
    const offerCode = String(b.offer_code ?? b.offerCode ?? '').trim()

    const result = await billing.redeemOfferCodeForDevice(deviceId, offerCode)

    if (result.locked === true) {
      return res.status(429).json({
        ok: false,
        locked: true,
        remaining_seconds: result.remainingSeconds ?? 0,
      })
    }

    if (!result.ok) {
      return res.status(400).json({
        ok: false,
        error: result.error || 'Redeem failed',
      })
    }

    const grant = result.grant
    const manualGift = manualGiftPayloadFromGrant(grant)
    const manualGiftAckKey = grant ? String(grant.grantId) : ''

    deviceSubscriptionBus.emit('update', { deviceId })
    liveSyncBus.publish('analytics.subscription_updated', {
      topics: ['analytics'],
      deviceId,
      orderId: `offer_code:${grant?.grantId ?? ''}`,
    })

    res.json({
      ok: true,
      manualGift,
      manualGiftAckKey,
    })
  } catch (e) {
    console.error('[redeem-offer-code]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

/** GET /subscription-status — primary unlock check by device_id (poll every ~3s as fallback). */
subscriptionRouter.get('/subscription-status', async (req, res) => {
  try {
    const deviceId = String(req.query.device_id ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required' })
    }
    const orderIdHint = String(req.query.order_id ?? '').trim()
    const fp = String(req.query.fingerprint ?? req.headers['x-device-fingerprint'] ?? '').trim()
    console.log('[subscription-verify] enter', {
      method: 'GET',
      path: '/subscription-status',
      deviceId: shortRef(deviceId),
      order_id: orderIdHint ? shortRef(orderIdHint) : undefined,
    })

    const bodyOut = await executeSubscriptionVerify(req, { deviceId, orderIdHint, fingerprint: fp })

    console.log('[subscription-verify] response', {
      method: 'GET',
      deviceId: shortRef(deviceId),
      active: bodyOut.active === true,
      isActive: bodyOut.isActive === true,
      playbackAllowed: bodyOut.playbackAllowed === true,
      status: bodyOut.status,
      expiresAt: bodyOut.expiresAt ? shortRef(bodyOut.expiresAt, 28) : null,
    })

    res.json(bodyOut)
  } catch (e) {
    console.error('[subscription-status]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/**
 * POST /subscription/verify — same logic as GET /subscription-status (mobile app compatibility).
 * Body: { device_id, device_fingerprint | fingerprint, order_id? }
 */
subscriptionRouter.post('/subscription/verify', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(b.device_id ?? b.deviceId ?? '').trim()
    if (!deviceId) {
      return res.status(400).json({ error: 'device_id is required' })
    }
    const orderIdHint = String(b.order_id ?? b.orderId ?? '').trim()
    const fp = String(
      b.device_fingerprint ?? b.fingerprint ?? b.deviceFingerprint ?? req.headers['x-device-fingerprint'] ?? '',
    ).trim()

    console.log('[subscription-verify] enter', {
      method: 'POST',
      path: '/subscription/verify',
      deviceId: shortRef(deviceId),
      order_id: orderIdHint ? shortRef(orderIdHint) : undefined,
    })

    const bodyOut = await executeSubscriptionVerify(req, { deviceId, orderIdHint, fingerprint: fp })

    console.log('[subscription-verify] response', {
      method: 'POST',
      deviceId: shortRef(deviceId),
      active: bodyOut.active === true,
      isActive: bodyOut.isActive === true,
      playbackAllowed: bodyOut.playbackAllowed === true,
      status: bodyOut.status,
      expiresAt: bodyOut.expiresAt ? shortRef(bodyOut.expiresAt, 28) : null,
    })

    res.json(bodyOut)
  } catch (e) {
    console.error('[subscription/verify]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

/** GET /subscription-stream — SSE realtime (same-node process). RN can use RN Firebase/other; web uses EventSource. */
subscriptionRouter.get('/subscription-stream', (req, res) => {
  const deviceId = String(req.query.device_id ?? '').trim()
  if (!deviceId) {
    res.status(400).json({ error: 'device_id is required' })
    return
  }
  const country = countryFromRequest(req)
  void billing.touchLivePresence({ deviceId, country }).catch((e) => {
    console.error('[subscription-stream] touchLivePresence failed:', e)
  })
  liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const toSsePayload = (row) => {
    const pub = rowToPublicStatus(row)
    return { isActive: pub.isActive === true, expiresAt: pub.expiresAt ?? null }
  }

  const send = () => {
    void (async () => {
      try {
        const fp = String(req.query.fingerprint ?? req.headers['x-device-fingerprint'] ?? '').trim()
        const row = await billing.getDeviceSubscriptionAccessState(deviceId, fp)
        const payload = toSsePayload(row)
        res.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`)
      } catch (e) {
        console.error('[subscription-stream] snapshot failed:', e)
      }
    })()
  }
  send()

  const writeAppModesEvent = async (reason) => {
    try {
      const p = await loadGlobalAppModesPayload()
      res.write(`event: app_modes\ndata: ${JSON.stringify({ ...p, reason })}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] app_modes push failed:', e)
    }
  }
  void writeAppModesEvent('init')

  const modeSyncHandler = (packet) => {
    if (!packet?.payload?.modes) return
    void writeAppModesEvent(String(packet.event || 'settings'))
  }
  liveSyncBus.on('sync', modeSyncHandler)

  const modePoll = setInterval(() => {
    void writeAppModesEvent('poll')
  }, MODE_SSE_POLL_MS)

  const handler = async (payload) => {
    if (!payload || payload.deviceId !== deviceId) return
    try {
      const fp = String(req.query.fingerprint ?? req.headers['x-device-fingerprint'] ?? '').trim()
      const row = await billing.getDeviceSubscriptionAccessState(deviceId, fp)
      res.write(`event: device_subscription\ndata: ${JSON.stringify(toSsePayload(row))}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] device_subscription event failed:', e)
    }
  }

  deviceSubscriptionBus.on('update', handler)

  const ping = setInterval(() => {
    res.write(': ping\n\n')
  }, 20_000)

  req.on('close', () => {
    clearInterval(ping)
    clearInterval(modePoll)
    deviceSubscriptionBus.off('update', handler)
    liveSyncBus.off('sync', modeSyncHandler)
    try {
      res.end()
    } catch (e) {
      console.error('[subscription-stream] close res.end failed:', e)
    }
  })
})
