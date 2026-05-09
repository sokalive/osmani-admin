import { Router } from 'express'
import * as billing from '../billingStore.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'

export const subscriptionRouter = Router()

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

  if (!pub.active) {
    const plans = await billing.listPlansWithSubscriberCounts().catch(() => [])
    return {
      ...normalized,
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
  return { ...normalized, playbackAllowed: true }
}

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
    deviceSubscriptionBus.off('update', handler)
    try {
      res.end()
    } catch (e) {
      console.error('[subscription-stream] close res.end failed:', e)
    }
  })
})
