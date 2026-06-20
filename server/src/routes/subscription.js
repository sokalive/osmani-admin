import { Router } from 'express'
import * as billing from '../billingStore.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'
import { getDeviceTrialWatchStatus } from '../lib/trialWatchStore.js'
import { loadTrialWatchSettings, trialWatchSettingsToPublicPayload } from '../lib/trialWatchSettings.js'
import { loadAppUpdatePublicPayload } from './appUpdate.js'
import { extractVersionCodeFromRequest } from '../lib/clientApiTelemetry.js'
import { ensureSubscriptionLinkedForDevice, tagActiveSubscriptionFingerprint } from '../lib/subscriptionRecovery.js'
import { parseChannelIdFromRequest } from '../lib/analyticsPresence.js'

export const subscriptionRouter = Router()

/** Cross-instance fallback: modes are in Postgres; keep interval Android-friendly (was 2500ms). */
const MODE_SSE_POLL_MS = Math.min(60_000, Math.max(750, Number(process.env.MODE_SSE_POLL_MS) || 1200))

function countryFromRequest(req) {
  const raw =
    req.headers['cf-ipcountry'] ||
    req.headers['x-country-code'] ||
    req.headers['x-vercel-ip-country'] ||
    ''
  const c = String(raw ?? '').trim().toUpperCase()
  if (!c || c.length < 2) return null
  return c.slice(0, 2)
}

function shortRef(id, n = 14) {
  const s = String(id ?? '')
  return s.length <= n ? s : `${s.slice(0, n)}…`
}

function migrationHintsFromPayload(src) {
  const b = src && typeof src === 'object' ? src : {}
  const legacyDeviceId = String(
    b.legacy_device_id ??
      b.legacyDeviceId ??
      b.previous_device_id ??
      b.previousDeviceId ??
      b.source_device_id ??
      b.sourceDeviceId ??
      b.displayed_account_id ??
      b.displayedAccountId ??
      '',
  ).trim()
  const accountId = String(b.account_id ?? b.accountId ?? '').trim()
  return { legacyDeviceId: legacyDeviceId || null, accountId: accountId || null }
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

function reminderFieldsFromRow(row) {
  if (!row) {
    return {
      remainingSeconds: 0,
      remaining_seconds: 0,
      remainingHours: 0,
      remaining_hours: 0,
      remainingDays: 0,
      remaining_days: 0,
      nearExpiry: false,
      near_expiry: false,
    }
  }
  const rs = row.remaining_seconds
  const remSec = rs != null ? Number(rs) : 0
  const safeSec = Number.isFinite(remSec) && remSec > 0 ? Math.floor(remSec) : 0
  const rh = row.remaining_hours
  const remHr = rh != null ? Number(rh) : 0
  const rd = row.remaining_days
  const remDay = rd != null ? Number(rd) : 0
  return {
    remainingSeconds: safeSec,
    remaining_seconds: safeSec,
    remainingHours: Number.isFinite(remHr) && remHr > 0 ? remHr : 0,
    remaining_hours: Number.isFinite(remHr) && remHr > 0 ? remHr : 0,
    remainingDays: Number.isFinite(remDay) && remDay > 0 ? remDay : 0,
    remaining_days: Number.isFinite(remDay) && remDay > 0 ? remDay : 0,
    nearExpiry: Boolean(row.near_expiry),
    near_expiry: Boolean(row.near_expiry),
  }
}

function rowToPublicStatus(row) {
  if (!row) {
    return {
      active: false,
      status: null,
      expiresAt: null,
      expires_at: null,
      ...reminderFieldsFromRow(null),
    }
  }
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
    expires_at: expiresAt,
    blocked: row.blocked_now === true,
    blockReason: row.block_reason ? String(row.block_reason) : null,
    ...reminderFieldsFromRow(row),
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
  const expiresAt = pub.expiresAt ?? pub.expires_at ?? null
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
    expiresAt,
    expires_at: expiresAt,
    amount,
    currency,
    plan_duration_days: planDurationDays,
    planDurationDays: planDurationDays,
  }
}

function appModesForVerify(modesPayload) {
  const body = modesPayload && typeof modesPayload === 'object' ? modesPayload : {}
  const appModes = {
    ok: body.ok !== false,
    v: body.v != null ? Number(body.v) || 0 : 0,
    free_mode: body.free_mode === true,
    emergency_mode: body.emergency_mode === true,
    maintenance_mode: body.maintenance_mode === true,
    server_time_ms: body.server_time_ms != null ? Number(body.server_time_ms) || null : null,
  }
  return {
    app_modes: appModes,
    free_mode: appModes.free_mode,
    emergency_mode: appModes.emergency_mode,
    maintenance_mode: appModes.maintenance_mode,
  }
}

function derivePlaybackGate(pub, modesPayload, securityPolicy = null, trialStatus = null) {
  const modes = appModesForVerify(modesPayload).app_modes
  if (modes.emergency_mode) {
    return { playbackAllowed: false, playbackGateReason: 'emergency_mode', limitedPlayback: false }
  }
  if (modes.maintenance_mode) {
    return { playbackAllowed: false, playbackGateReason: 'maintenance_mode', limitedPlayback: false }
  }
  if (pub.blocked === true) {
    return { playbackAllowed: false, playbackGateReason: 'blocked_device', limitedPlayback: false }
  }

  let baseAllowed = false
  let baseReason = 'subscription_inactive'
  if (pub.active === true) {
    baseAllowed = true
    baseReason = 'subscription_active'
  } else if (modes.free_mode) {
    baseAllowed = true
    baseReason = 'free_mode'
  } else if (trialStatus?.playbackAllowed === true) {
    baseAllowed = true
    baseReason = String(trialStatus.playbackGateReason || 'trial_watch_active')
  }

  const sec = securityPolicy && typeof securityPolicy === 'object' ? securityPolicy : null
  if (sec?.whitelisted) {
    return {
      playbackAllowed: baseAllowed,
      playbackGateReason: baseReason,
      limitedPlayback: false,
      securityLevel: sec.security_level || 'warning',
      securityBypass: true,
    }
  }
  if (sec?.deny_playback) {
    return {
      playbackAllowed: false,
      playbackGateReason: 'security_blocked',
      limitedPlayback: false,
      securityLevel: sec.security_level || 'blocked',
    }
  }
  if (sec?.limited_playback && baseAllowed) {
    return {
      playbackAllowed: true,
      playbackGateReason: baseReason,
      limitedPlayback: true,
      securityLevel: sec.security_level || 'limited',
    }
  }

  return {
    playbackAllowed: baseAllowed,
    playbackGateReason: baseReason,
    limitedPlayback: false,
    securityLevel: sec?.security_level || null,
  }
}

/**
 * Shared path for GET /subscription-status and POST /subscription/verify:
 * presence touch, reconcile + activate, then access state + plans.
 */
async function executeSubscriptionVerify(req, { deviceId, orderIdHint, fingerprint, phone = null, legacyDeviceId = null, accountId = null }) {
  const country = countryFromRequest(req)
  const d = String(deviceId ?? '').trim()
  const hint = String(orderIdHint ?? '').trim()
  const fp = String(fingerprint ?? '').trim()
  const paymentPhone = String(phone ?? '').trim()
  const channelId = parseChannelIdFromRequest(req)

  await billing.touchLivePresence({ deviceId: d, country, channelId }).catch((e) => {
    console.error('[subscription-verify] touchLivePresence failed:', e)
  })
  liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId: d })

  await reconcileOrdersForVerify(d, hint)

  const link = await ensureSubscriptionLinkedForDevice(d, {
    fingerprint: fp || null,
    phone: paymentPhone || null,
    legacyDeviceId: legacyDeviceId || null,
    accountId: accountId || null,
  }).catch((e) => {
    console.error('[subscription-verify] ensureSubscriptionLinkedForDevice failed:', e)
    return { linked: false, reason: 'link_error' }
  })
  if (link.linked) {
    console.log('[subscription-verify] subscription linked', {
      deviceId: shortRef(d),
      method: link.method,
      from: link.recovered_from ? shortRef(link.recovered_from) : undefined,
    })
  } else if (fp) {
    await tagActiveSubscriptionFingerprint(d, fp).catch(() => {})
  }

  const row = await billing.getDeviceSubscriptionAccessState(d, fp)
  const pub = rowToPublicStatus(row)
  const txnSummary = await billing.getLatestCompletedSubscriptionTxnSummary(d)
  const normalized = normalizeVerifyResponse(pub, txnSummary)
  const modesPayload = await loadGlobalAppModesPayload().catch(() => ({
    ok: false,
    v: liveSyncBus.snapshot().configVersion,
    free_mode: false,
    emergency_mode: false,
    maintenance_mode: false,
    server_time_ms: Date.now(),
  }))
  const runtimeModes = appModesForVerify(modesPayload)
  const securityPolicy = await import('../lib/deviceSecurityStore.js')
    .then((m) => m.getPlaybackSecurityPolicy(d))
    .catch(() => null)
  const trialStatus = await getDeviceTrialWatchStatus(d, fp).catch(() => null)
  const playbackGate = derivePlaybackGate(pub, modesPayload, securityPolicy, trialStatus)

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
      appModes: runtimeModes.app_modes,
      playbackGate,
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

  const trialWatchSettings = await loadTrialWatchSettings().catch(() => ({
    enabled: false,
    trialMinutes: 30,
    previewSeconds: 120,
    previewAfterEnabled: true,
  }))
  const trialWatchPublic = trialWatchSettingsToPublicPayload(
    trialWatchSettings,
    modesPayload?.v ?? liveSyncBus.snapshot().configVersion,
  )

  const withGift = {
    ...normalized,
    ...runtimeModes,
    manualGift,
    trial_watch: trialStatus,
    trialWatch: trialStatus,
    trial_watch_settings: trialWatchPublic,
    trialWatchSettings: trialWatchPublic,
    playbackAllowed: playbackGate.playbackAllowed,
    playbackGateReason: playbackGate.playbackGateReason,
    limitedPlayback: playbackGate.limitedPlayback === true,
    securityLevel: playbackGate.securityLevel ?? null,
    securityBypass: playbackGate.securityBypass === true,
  }

  if (!pub.active) {
    const plans = await billing.listPlansWithSubscriberCounts().catch(() => [])
    return {
      ...withGift,
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
  return withGift
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
    void recordSystemNotificationEvent('subscription_offer_code_redeemed', {
      device_id: deviceId,
      grant_id: grant?.grantId ?? null,
      offer_code: offerCode,
    }).catch((err) => {
      console.error('[redeem-offer-code] notification sync failed:', err)
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
    const paymentPhone = String(req.query.payment_phone ?? req.query.phone ?? '').trim()
    const migration = migrationHintsFromPayload(req.query)
    console.log('[subscription-verify] enter', {
      method: 'GET',
      path: '/subscription-status',
      deviceId: shortRef(deviceId),
      order_id: orderIdHint ? shortRef(orderIdHint) : undefined,
    })

    const bodyOut = await executeSubscriptionVerify(req, {
      deviceId,
      orderIdHint,
      fingerprint: fp,
      phone: paymentPhone,
      legacyDeviceId: migration.legacyDeviceId,
      accountId: migration.accountId,
    })

    console.log('[subscription-verify] response', {
      method: 'GET',
      deviceId: shortRef(deviceId),
      active: bodyOut.active === true,
      isActive: bodyOut.isActive === true,
      playbackAllowed: bodyOut.playbackAllowed === true,
      playbackGateReason: bodyOut.playbackGateReason ?? null,
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
    const paymentPhone = String(b.payment_phone ?? b.phone ?? b.paymentPhone ?? '').trim()
    const migration = migrationHintsFromPayload(b)

    console.log('[subscription-verify] enter', {
      method: 'POST',
      path: '/subscription/verify',
      deviceId: shortRef(deviceId),
      order_id: orderIdHint ? shortRef(orderIdHint) : undefined,
    })

    const bodyOut = await executeSubscriptionVerify(req, {
      deviceId,
      orderIdHint,
      fingerprint: fp,
      phone: paymentPhone,
      legacyDeviceId: migration.legacyDeviceId,
      accountId: migration.accountId,
    })

    console.log('[subscription-verify] response', {
      method: 'POST',
      deviceId: shortRef(deviceId),
      active: bodyOut.active === true,
      isActive: bodyOut.isActive === true,
      playbackAllowed: bodyOut.playbackAllowed === true,
      playbackGateReason: bodyOut.playbackGateReason ?? null,
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
  const channelId = parseChannelIdFromRequest(req)
  void billing.touchLivePresence({ deviceId, country, channelId }).catch((e) => {
    console.error('[subscription-stream] touchLivePresence failed:', e)
  })
  liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders?.()

  const toSsePayload = (row) => {
    const pub = rowToPublicStatus(row)
    return {
      isActive: pub.isActive === true,
      expiresAt: pub.expiresAt ?? null,
      expires_at: pub.expires_at ?? null,
      remainingSeconds: pub.remainingSeconds ?? 0,
      remaining_seconds: pub.remaining_seconds ?? 0,
      remainingHours: pub.remainingHours ?? 0,
      remaining_hours: pub.remaining_hours ?? 0,
      remainingDays: pub.remainingDays ?? 0,
      remaining_days: pub.remaining_days ?? 0,
      nearExpiry: pub.nearExpiry === true,
      near_expiry: pub.near_expiry === true,
    }
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
      const body = JSON.stringify({ ...p, reason })
      res.write(`event: app_modes\ndata: ${body}\n\n`)
      // Legacy APK EventSource listeners (same payload as app_modes).
      res.write(`event: app_settings_changed\ndata: ${body}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] app_modes push failed:', e)
    }
  }
  void writeAppModesEvent('init')

  const writeTrialWatchEvent = async (reason) => {
    try {
      const settings = await loadTrialWatchSettings()
      const snap = liveSyncBus.snapshot()
      const body = JSON.stringify({
        ...trialWatchSettingsToPublicPayload(settings, snap.configVersion),
        reason,
      })
      res.write(`event: trial_watch_settings\ndata: ${body}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] trial_watch_settings push failed:', e)
    }
  }
  void writeTrialWatchEvent('init')

  const writeAppUpdateEvent = async (reason) => {
    try {
      const snap = liveSyncBus.snapshot()
      const clientVersion = extractVersionCodeFromRequest(req)
      const body = JSON.stringify({
        ...(await loadAppUpdatePublicPayload(snap.configVersion, clientVersion)),
        reason,
      })
      res.write(`event: app_update_settings\ndata: ${body}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] app_update_settings push failed:', e)
    }
  }
  void writeAppUpdateEvent('init')

  const modeSyncHandler = (packet) => {
    const modes = packet?.payload?.modes
    if (!modes || typeof modes !== 'object') return
    const immediate = {
      ok: true,
      v: packet.configVersion,
      free_mode: modes.free_mode === true,
      emergency_mode: modes.emergency_mode === true,
      maintenance_mode: modes.maintenance_mode === true,
      server_time_ms: Date.now(),
      reason: String(packet.event || 'settings'),
    }
    const body = JSON.stringify(immediate)
    try {
      res.write(`event: app_modes\ndata: ${body}\n\n`)
      res.write(`event: app_settings_changed\ndata: ${body}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] immediate modes push failed:', e)
    }
  }
  const trialSyncHandler = (packet) => {
    const tw = packet?.payload?.trial_watch
    if (!tw || typeof tw !== 'object') return
    try {
      const body = JSON.stringify({
        ...tw,
        reason: String(packet.event || 'trial_watch'),
      })
      res.write(`event: trial_watch_settings\ndata: ${body}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] trial_watch immediate push failed:', e)
    }
  }
  const appUpdateSyncHandler = (packet) => {
    const au = packet?.payload?.app_update
    if (!au || typeof au !== 'object') return
    try {
      const body = JSON.stringify({
        ...au,
        reason: String(packet.event || 'app_update'),
      })
      res.write(`event: app_update_settings\ndata: ${body}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] app_update immediate push failed:', e)
    }
  }
  const catalogSyncHandler = (packet) => {
    const event = String(packet?.event || '')
    const catalogEvents = new Set([
      'config.channels_changed',
      'config.banners_changed',
      'config.plans_changed',
      'config.payment_providers_changed',
    ])
    if (!catalogEvents.has(event)) return
    try {
      const body = JSON.stringify({
        v: packet.configVersion,
        event,
        action: packet?.payload?.action ?? null,
        reason: event,
      })
      res.write(`event: catalog_refresh\ndata: ${body}\n\n`)
      if (event === 'config.channels_changed') {
        res.write(`event: channels_catalog\ndata: ${body}\n\n`)
        res.write(`event: channels_changed\ndata: ${body}\n\n`)
      }
      if (event === 'config.banners_changed') {
        res.write(`event: banners_changed\ndata: ${body}\n\n`)
      }
      if (event === 'config.plans_changed') {
        res.write(`event: plans_changed\ndata: ${body}\n\n`)
      }
    } catch (e) {
      console.error('[subscription-stream] catalog refresh push failed:', e)
    }
  }

  liveSyncBus.on('sync', modeSyncHandler)
  liveSyncBus.on('sync', trialSyncHandler)
  liveSyncBus.on('sync', appUpdateSyncHandler)
  liveSyncBus.on('sync', catalogSyncHandler)

  const modePoll = setInterval(() => {
    void writeAppModesEvent('poll')
    void writeTrialWatchEvent('poll')
    void writeAppUpdateEvent('poll')
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
    void billing.touchLivePresence({ deviceId, country, channelId }).catch((e) => {
      console.error('[subscription-stream] presence ping failed:', e)
    })
    liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
  }, 20_000)

  req.on('close', () => {
    clearInterval(ping)
    clearInterval(modePoll)
    deviceSubscriptionBus.off('update', handler)
    liveSyncBus.off('sync', modeSyncHandler)
    liveSyncBus.off('sync', trialSyncHandler)
    liveSyncBus.off('sync', appUpdateSyncHandler)
    liveSyncBus.off('sync', catalogSyncHandler)
    try {
      res.end()
    } catch (e) {
      console.error('[subscription-stream] close res.end failed:', e)
    }
  })
})
