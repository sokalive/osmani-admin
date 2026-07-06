import { Router } from 'express'
import * as billing from '../billingStore.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { recordSystemNotificationEvent } from '../lib/runtimeNotifications.js'
import { loadGlobalAppModesPayload } from './globalAppSettings.js'
import { loadPhoneGatePublicPayload } from '../lib/phoneGateSettings.js'
import { getDeviceTrialWatchStatus } from '../lib/trialWatchStore.js'
import { loadTrialWatchSettings, trialWatchSettingsToPublicPayload } from '../lib/trialWatchSettings.js'
import { loadAppUpdatePublicPayload } from './appUpdate.js'
import { extractVersionCodeFromRequest } from '../lib/clientApiTelemetry.js'
import { ensureSubscriptionLinkedForDevice, tagActiveSubscriptionFingerprint, tryFastFingerprintRecovery } from '../lib/subscriptionRecovery.js'
import { parseChannelRefFromRequest } from '../lib/analyticsPresence.js'
import {
  getCachedSubscriptionAccess,
  getStaleCachedSubscriptionAccess,
  invalidateSubscriptionAccessCache,
  setCachedSubscriptionAccess,
} from '../lib/subscriptionAccessCache.js'
import {
  canUseInactiveVerifyFallback,
  isDbTimeoutOrPressureError,
  withVerifyDbSlot,
} from '../lib/verifyDbResilience.js'
import { coalesceVerifyAccessLoad } from '../lib/verifyAccessSingleflight.js'
import { isCompletedTransferSourceDevice } from '../lib/transferRevocationGuard.js'
import {
  writeManualGrantSseEvents,
  writeSubscriptionWakeSseEvents,
  writeAdminRevokedSseEvents,
} from '../lib/manualSubscriptionSseContract.js'
import { flushSseResponse } from '../lib/sseFlush.js'

export const subscriptionRouter = Router()

deviceSubscriptionBus.on('update', ({ deviceId }) => {
  invalidateSubscriptionAccessCache(deviceId)
})

/** Cross-instance fallback: modes are in Postgres; 1200ms proven stable at ~500 concurrent (ed9541d). */
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

function hasMigrationHintsForVerify({ fp, paymentPhone, legacyDeviceId, accountId }) {
  const phone = String(paymentPhone ?? '').replace(/\D/g, '')
  const acct = String(accountId ?? '').replace(/\D/g, '')
  return (
    Boolean(String(fp ?? '').trim()) ||
    Boolean(String(legacyDeviceId ?? '').trim()) ||
    Boolean(String(accountId ?? '').trim()) ||
    phone.length >= 10 ||
    acct.length >= 10
  )
}

function verifySlowLogThresholdMs() {
  return Math.max(500, Number(process.env.SUBSCRIPTION_VERIFY_SLOW_MS) || 1500)
}

function mapVerifyPlans(rows) {
  return Array.isArray(rows)
    ? rows.map((p) => ({
        id: Number(p.id),
        name: String(p.name ?? ''),
        price: Number(p.price) || 0,
        duration_days: Number(p.duration_days) || 0,
      }))
    : []
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
    await reconcileOrderWithZenoPay(orderId, { forcePoll: true })
  }

  if (hint) {
    const hintPoll = await billing.shouldProviderPollOrderForVerify(d, hint)
    if (hintPoll.poll) {
      await guardedReconcile(hint)
    }
  } else {
    const pend = await billing.getLatestRecentPendingTransactionForDevice(d)
    if (pend?.order_id) {
      await reconcileOrderWithZenoPay(String(pend.order_id), { forcePoll: true })
    }
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
      isActive: false,
      status: null,
      expiresAt: null,
      expires_at: null,
      blocked: false,
      blockReason: null,
      ...reminderFieldsFromRow(null),
    }
  }
  const active = isAccessRowActive(row)
  const isAdminRevoked =
    String(row.status ?? '').toLowerCase() === 'revoked' || row.admin_revoked_at != null
  const status =
    row.blocked_now === true
      ? 'blocked'
      : isAdminRevoked
        ? 'revoked'
        : active
          ? 'active'
          : row.status === 'active'
            ? 'expired'
            : row.status
  const exp = row.expires_at
  const expiresAt = exp instanceof Date ? exp.toISOString() : exp != null ? String(exp) : null
  const startedRaw = row.started_at
  const startedAt =
    startedRaw instanceof Date
      ? startedRaw.toISOString()
      : startedRaw != null
        ? String(startedRaw)
        : null
  const inactiveReason = isAdminRevoked
    ? 'admin_revoked'
    : active
      ? null
      : row.status === 'active'
        ? 'expired'
        : String(status || 'inactive')
  return {
    active,
    /** legacy alias used by RN clients */
    isActive: active,
    status,
    expiresAt,
    expires_at: expiresAt,
    startedAt,
    started_at: startedAt,
    blocked: row.blocked_now === true,
    blockReason: row.block_reason ? String(row.block_reason) : null,
    inactive_reason: inactiveReason,
    inactiveReason,
    admin_revoked: isAdminRevoked,
    adminRevoked: isAdminRevoked,
    suppress_expiry_popup: isAdminRevoked,
    suppressExpiryPopup: isAdminRevoked,
    entitlement_state: isAdminRevoked ? 'revoked' : active ? 'active' : 'inactive',
    entitlementState: isAdminRevoked ? 'revoked' : active ? 'active' : 'inactive',
    admin_revoked_at:
      row.admin_revoked_at instanceof Date
        ? row.admin_revoked_at.toISOString()
        : row.admin_revoked_at != null
          ? String(row.admin_revoked_at)
          : null,
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
  const planNameRaw =
    txnSummary?.plan_name != null ? String(txnSummary.plan_name).trim() : ''
  const planName = planNameRaw || null
  const startedAt =
    pub.startedAt ??
    pub.started_at ??
    (txnSummary?.started_at != null ? String(txnSummary.started_at) : null)
  const activatedAt =
    txnSummary?.activated_at != null ? String(txnSummary.activated_at) : null

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
    planName,
    plan_name: planName,
    source: txnSummary?.source != null ? String(txnSummary.source) : null,
    plan_duration_days: planDurationDays,
    planDurationDays: planDurationDays,
    duration: planDurationDays,
    durationDays: planDurationDays,
    startedAt,
    started_at: startedAt,
    activatedAt,
    activated_at: activatedAt,
    subscription_extension_policy: 'stack_on_active',
    subscriptionExtensionPolicy: 'stack_on_active',
    entitlement_remaining_days: pub.remaining_days ?? pub.remainingDays ?? 0,
    entitlementRemainingDays: pub.remaining_days ?? pub.remainingDays ?? 0,
    is_stacked_entitlement:
      planDurationDays != null &&
      (pub.remaining_days ?? pub.remainingDays ?? 0) > planDurationDays + 0,
    isStackedEntitlement:
      planDurationDays != null &&
      (pub.remaining_days ?? pub.remainingDays ?? 0) > planDurationDays + 0,
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

function modesFallbackPayload() {
  return {
    ok: false,
    v: liveSyncBus.snapshot().configVersion,
    free_mode: false,
    emergency_mode: false,
    maintenance_mode: false,
    server_time_ms: Date.now(),
  }
}

const trialSettingsFallbackPayload = {
  enabled: false,
  trialMinutes: 30,
  previewSeconds: 120,
  previewAfterEnabled: true,
}

const trialDisabledPublicPayload = {
  enabled: false,
  playbackAllowed: false,
  playbackGateReason: 'subscription_active',
  phase: 'disabled',
}

/**
 * Safe HTTP 200 inactive verify when DB is saturated — never used for paid/migration/payment hints.
 */
async function buildInactiveVerifyFallbackResponse(req, deviceId) {
  const pub = rowToPublicStatus(null)
  const modesPayload = await loadGlobalAppModesPayload().catch(() => modesFallbackPayload())
  const plansRows = await billing.listActivePlansForVerify().catch(() => [])
  const normalized = normalizeVerifyResponse(pub, null)
  const runtimeModes = appModesForVerify(modesPayload)
  const playbackGate = derivePlaybackGate(pub, modesPayload, null, null)
  const trialWatchPublic = trialWatchSettingsToPublicPayload(
    trialSettingsFallbackPayload,
    modesPayload?.v ?? liveSyncBus.snapshot().configVersion,
  )
  const withGift = {
    ...normalized,
    ...runtimeModes,
    manualGift: null,
    trial_watch: null,
    trialWatch: null,
    trial_watch_settings: trialWatchPublic,
    trialWatchSettings: trialWatchPublic,
    playbackAllowed: playbackGate.playbackAllowed,
    playbackGateReason: playbackGate.playbackGateReason,
    limitedPlayback: playbackGate.limitedPlayback === true,
    securityLevel: playbackGate.securityLevel ?? null,
    securityBypass: playbackGate.securityBypass === true,
    plans: mapVerifyPlans(plansRows),
  }
  console.warn('[subscription-verify-fallback]', {
    deviceId: shortRef(deviceId),
    path: req.path || req.url || '',
  })
  return withGift
}

/** Preserve known-active subscription from cache when DB is saturated (never upgrades unpaid). */
async function buildActiveVerifyFallbackFromCache(req, deviceId, row) {
  const pub = rowToPublicStatus(row)
  const modesPayload = await loadGlobalAppModesPayload().catch(() => modesFallbackPayload())
  const txnSummary = await billing
    .getLatestCompletedSubscriptionTxnSummary(deviceId)
    .catch(() => null)
  const normalized = normalizeVerifyResponse(pub, txnSummary)
  const runtimeModes = appModesForVerify(modesPayload)
  const playbackGate = derivePlaybackGate(pub, modesPayload, null, trialDisabledPublicPayload)
  const trialWatchPublic = trialWatchSettingsToPublicPayload(
    trialSettingsFallbackPayload,
    modesPayload?.v ?? liveSyncBus.snapshot().configVersion,
  )
  console.warn('[subscription-verify-active-fallback]', {
    deviceId: shortRef(deviceId),
    path: req.path || req.url || '',
  })
  return {
    ...normalized,
    ...runtimeModes,
    manualGift: null,
    trial_watch: trialDisabledPublicPayload,
    trialWatch: trialDisabledPublicPayload,
    trial_watch_settings: trialWatchPublic,
    trialWatchSettings: trialWatchPublic,
    playbackAllowed: playbackGate.playbackAllowed,
    playbackGateReason: playbackGate.playbackGateReason,
    limitedPlayback: false,
    securityLevel: playbackGate.securityLevel ?? null,
    securityBypass: playbackGate.securityBypass === true,
  }
}

async function maybeActiveVerifyFallback(req, deviceId, fingerprint, err) {
  if (!isDbTimeoutOrPressureError(err)) return null
  const stale =
    getCachedSubscriptionAccess(deviceId, fingerprint) ??
    getStaleCachedSubscriptionAccess(deviceId, fingerprint)
  if (!isAccessRowActive(stale)) return null
  try {
    return await buildActiveVerifyFallbackFromCache(req, deviceId, stale)
  } catch (fallbackErr) {
    console.error('[subscription-verify-active-fallback] failed:', fallbackErr)
    return null
  }
}

/** Never downgrade paid users: cache → stale cache → fast DB before any inactive verify body. */
async function tryLastResortActiveVerifyFallback(req, deviceId, fingerprint) {
  const fp = String(fingerprint ?? '').trim()
  const transferRevokedSource = await isCompletedTransferSourceDevice(deviceId)
  const cached = getCachedSubscriptionAccess(deviceId, fp)
  if (isAccessRowActive(cached) && !transferRevokedSource) {
    return buildActiveVerifyFallbackFromCache(req, deviceId, cached)
  }
  const stale = getStaleCachedSubscriptionAccess(deviceId, fp)
  if (isAccessRowActive(stale) && !transferRevokedSource) {
    return buildActiveVerifyFallbackFromCache(req, deviceId, stale)
  }
  if (transferRevokedSource) {
    try {
      const fast = await billing.getDeviceSubscriptionAccessStateFast(deviceId)
      if (!isAccessRowActive(fast)) return null
      setCachedSubscriptionAccess(deviceId, fp, fast)
      return buildActiveVerifyFallbackFromCache(req, deviceId, fast)
    } catch {
      return null
    }
  }
  try {
    const fast = await billing.getDeviceSubscriptionAccessStateFast(deviceId)
    if (isAccessRowActive(fast)) {
      setCachedSubscriptionAccess(deviceId, fp, fast)
      return buildActiveVerifyFallbackFromCache(req, deviceId, fast)
    }
  } catch (e) {
    console.warn('[subscription-verify-last-resort-active] fast lookup failed:', e?.message || e)
  }
  return null
}

function isAccessRowActive(row) {
  if (!row || row.blocked_now === true) return false
  const status = String(row.status ?? '').toLowerCase()
  if (status === 'revoked' || row.admin_revoked_at) return false
  return row.active_now === true && status === 'active'
}

function verifyFallbackContext({ deviceId, orderIdHint, fingerprint, phone, legacyDeviceId, accountId }) {
  const cached = getCachedSubscriptionAccess(deviceId, fingerprint)
  return {
    orderIdHint,
    fingerprint,
    legacyDeviceId,
    accountId,
    paymentPhone: phone,
    cachedAccessRow: cached !== undefined ? cached : null,
  }
}

async function respondSafeInactiveAfterVerifyError(req, res, deviceId, fingerprint, label, err) {
  const activeFb = await tryLastResortActiveVerifyFallback(req, deviceId, fingerprint)
  if (activeFb) {
    console.warn(`[${label}] last-resort active fallback after error:`, err?.message || err)
    return res.json(activeFb)
  }
  try {
    const body = await buildInactiveVerifyFallbackResponse(req, deviceId)
    console.warn(`[${label}] safe inactive HTTP 200 after error:`, err?.message || err)
    return res.json(body)
  } catch (buildErr) {
    console.error(`[${label}] safe inactive build failed:`, buildErr)
    return res.status(500).json({ error: String(err?.message || err) })
  }
}

async function maybeInactiveVerifyFallback(req, ctx, err) {
  if (!canUseInactiveVerifyFallback(ctx)) return null
  if (!isDbTimeoutOrPressureError(err)) return null
  try {
    return await buildInactiveVerifyFallbackResponse(req, ctx.deviceId || '')
  } catch (fallbackErr) {
    console.error('[subscription-verify-fallback] failed:', fallbackErr)
    return null
  }
}

/**
 * Shared path for GET /subscription-status and POST /subscription/verify:
 * presence touch, reconcile + activate, then access state + plans.
 */
async function executeSubscriptionVerify(req, { deviceId, orderIdHint, fingerprint, phone = null, legacyDeviceId = null, accountId = null }) {
  const verifyT0 = Date.now()
  const country = countryFromRequest(req)
  const d = String(deviceId ?? '').trim()
  const hint = String(orderIdHint ?? '').trim()
  const fp = String(fingerprint ?? '').trim()
  const paymentPhone = String(phone ?? '').trim()
  const channelRef = parseChannelRefFromRequest(req)
  const channelId = channelRef.channelId
  const channelName = channelRef.channelName
  const fallbackCtx = verifyFallbackContext({
    deviceId: d,
    orderIdHint: hint,
    fingerprint: fp,
    phone: paymentPhone,
    legacyDeviceId,
    accountId,
  })
  const timing = {
    deviceId: shortRef(d),
    hint: hint ? shortRef(hint) : null,
    path: req.path || req.url || '',
  }

  void billing.touchLivePresence({ deviceId: d, country, channelId, channelName }).catch((e) => {
    console.error('[subscription-verify] touchLivePresence failed:', e)
  })
  liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId: d })

  const tAccess0 = Date.now()
  let cached = getCachedSubscriptionAccess(d, fp)
  let row = cached !== undefined ? cached : null
  let accessSnapshot = null

  if (cached !== undefined && isAccessRowActive(row) && (await isCompletedTransferSourceDevice(d))) {
    invalidateSubscriptionAccessCache(d)
    cached = undefined
    row = null
  }

  if (cached === undefined) {
    try {
      accessSnapshot = await withVerifyDbSlot(() =>
        coalesceVerifyAccessLoad(d, () => billing.getVerifyAccessSnapshot(d)),
      )
      row = accessSnapshot.row
    } catch (e) {
      const staleActive = getStaleCachedSubscriptionAccess(d, fp)
      const transferRevokedSource = await isCompletedTransferSourceDevice(d)
      if (isAccessRowActive(staleActive) && !transferRevokedSource) {
        row = staleActive
        timing.stale_active_cache = true
      } else {
        const lastResort = await tryLastResortActiveVerifyFallback(req, d, fp)
        if (lastResort) {
          timing.last_resort_active = true
          return lastResort
        }
        const fb = await maybeInactiveVerifyFallback(req, { ...fallbackCtx, deviceId: d }, e)
        if (fb) {
          timing.access_pressure_fallback = true
          return fb
        }
        throw e
      }
    }
    setCachedSubscriptionAccess(d, fp, row)
  }
  timing.access_ms = Date.now() - tAccess0
  timing.access_cache_hit = cached !== undefined
  timing.access_fast_path = cached !== undefined || row != null

  const alreadyActive = isAccessRowActive(row)
  timing.already_active = alreadyActive
  let pollDecision = { poll: false, reason: 'already_active' }
  if (!alreadyActive) {
    try {
      pollDecision = await withVerifyDbSlot(() =>
        billing.resolveVerifyPollDecision(d, hint, accessSnapshot),
      )
    } catch (e) {
      const fb = await maybeInactiveVerifyFallback(req, { ...fallbackCtx, deviceId: d }, e)
      if (fb) {
        timing.access_pressure_fallback = true
        return fb
      }
      pollDecision = { poll: false, reason: 'poll_skipped_db_pressure' }
    }
  }
  timing.poll_decision = pollDecision

  if (pollDecision.poll) {
    const tRec0 = Date.now()
    try {
      await withVerifyDbSlot(() => reconcileOrdersForVerify(d, hint))
    } catch (e) {
      console.warn('[subscription-verify] reconcile skipped:', e?.message || e)
    }
    timing.reconcile_ms = Date.now() - tRec0
    timing.provider_polled = true
    invalidateSubscriptionAccessCache(d)
    row = (await billing.getDeviceSubscriptionAccessStateFast(d)) ??
      (await billing.getDeviceSubscriptionAccessState(d, fp))
    setCachedSubscriptionAccess(d, fp, row)
  } else {
    timing.skip_poll_reason = pollDecision.reason
    if (!isAccessRowActive(row)) {
      try {
        const fin = await billing.tryFinalizeActivationForDevice(d)
        if (fin.ran === true && fin.activated === true) {
          invalidateSubscriptionAccessCache(d)
          row =
            (await billing.getDeviceSubscriptionAccessStateFast(d)) ??
            (await billing.getDeviceSubscriptionAccessState(d, fp))
          setCachedSubscriptionAccess(d, fp, row)
          timing.sync_finalize_activation = true
        } else {
          timing.sync_finalize_activation = false
          timing.sync_finalize_reason = fin?.reason ?? null
        }
      } catch (e) {
        console.error('[subscription-verify] sync finalize failed:', e)
        timing.sync_finalize_error = String(e?.message || e)
      }
    }
  }

  const inactiveNow = !isAccessRowActive(row)
  const explicitMigration =
    Boolean(String(legacyDeviceId ?? '').trim()) ||
    Boolean(String(accountId ?? '').trim()) ||
    String(paymentPhone ?? '').replace(/\D/g, '').length >= 10

  if (inactiveNow && fp) {
    const tFp0 = Date.now()
    let fastLink = { linked: false, reason: 'skipped' }
    try {
      fastLink = await withVerifyDbSlot(() => tryFastFingerprintRecovery(d, fp))
    } catch (e) {
      if (!isDbTimeoutOrPressureError(e)) {
        console.error('[subscription-verify] fast fingerprint recovery failed:', e)
      }
      fastLink = { linked: false, reason: 'link_error' }
    }
    timing.fast_fp_recovery_ms = Date.now() - tFp0
    if (fastLink.linked) {
      console.log('[subscription-verify] fast fingerprint recovery', {
        deviceId: shortRef(d),
        from: fastLink.recovered_from ? shortRef(fastLink.recovered_from) : undefined,
      })
      invalidateSubscriptionAccessCache(d)
      row =
        (await billing.getDeviceSubscriptionAccessStateFast(d)) ??
        (await billing.getDeviceSubscriptionAccessState(d, fp))
      setCachedSubscriptionAccess(d, fp, row)
    }
  }

  const needsMigrationLink =
    !isAccessRowActive(row) &&
    explicitMigration &&
    hasMigrationHintsForVerify({ fp, paymentPhone, legacyDeviceId, accountId })

  if (needsMigrationLink) {
    const tLink0 = Date.now()
    let phoneHint = paymentPhone
    if (!phoneHint) {
      try {
        const resolved = await withVerifyDbSlot(() => billing.resolvePaymentPhoneForDevice(d))
        phoneHint = resolved?.phone || null
      } catch (_) {
        phoneHint = null
      }
    }
    let link = { linked: false, reason: 'skipped' }
    try {
      link = await withVerifyDbSlot(() =>
        ensureSubscriptionLinkedForDevice(d, {
          fingerprint: fp || null,
          phone: phoneHint || null,
          legacyDeviceId: legacyDeviceId || null,
          accountId: accountId || null,
        }),
      )
    } catch (e) {
      if (!isDbTimeoutOrPressureError(e)) {
        console.error('[subscription-verify] ensureSubscriptionLinkedForDevice failed:', e)
      }
      link = { linked: false, reason: 'link_error' }
    }
    if (link.linked) {
      console.log('[subscription-verify] subscription linked', {
        deviceId: shortRef(d),
        method: link.method,
        from: link.recovered_from ? shortRef(link.recovered_from) : undefined,
      })
      invalidateSubscriptionAccessCache(d)
      row = await billing.getDeviceSubscriptionAccessState(d, fp)
      setCachedSubscriptionAccess(d, fp, row)
    } else if (fp) {
      void tagActiveSubscriptionFingerprint(d, fp).catch(() => {})
    }
    timing.migration_ms = Date.now() - tLink0
    timing.migration_linked = link?.linked === true
  }

  const pub = rowToPublicStatus(row)
  const isActiveNow = isAccessRowActive(row)
  const needsPlans = !isActiveNow
  timing.active_result = isActiveNow

  const modesFallback = () => ({
    ok: false,
    v: liveSyncBus.snapshot().configVersion,
    free_mode: false,
    emergency_mode: false,
    maintenance_mode: false,
    server_time_ms: Date.now(),
  })
  const trialSettingsFallback = {
    enabled: false,
    trialMinutes: 30,
    previewSeconds: 120,
    previewAfterEnabled: true,
  }
  const trialDisabledPublic = {
    enabled: false,
    playbackAllowed: false,
    playbackGateReason: 'subscription_active',
    phase: 'disabled',
  }

  let txnSummary
  let modesPayload
  let securityPolicy
  let trialStatus
  let pendingGift
  let trialWatchSettings
  let plansRows

  const tParallel0 = Date.now()
  if (isActiveNow && !needsMigrationLink) {
    const pendingGiftPromise = billing.getOldestPendingManualGrant(d).catch(() => null)
    if (timing.access_cache_hit) {
      ;[modesPayload, txnSummary, pendingGift] = await Promise.all([
        loadGlobalAppModesPayload().catch(() => modesFallback()),
        billing.getLatestCompletedSubscriptionTxnSummary(d).catch(() => null),
        pendingGiftPromise,
      ])
      securityPolicy = null
      timing.active_zero_db = false
      timing.active_cache_metadata_fetch = true
    } else {
      ;[txnSummary, modesPayload, securityPolicy, pendingGift] = await Promise.all([
        billing.getLatestCompletedSubscriptionTxnSummary(d).catch(() => null),
        loadGlobalAppModesPayload().catch(() => modesFallback()),
        import('../lib/deviceSecurityStore.js')
          .then((m) => m.getPlaybackSecurityPolicy(d))
          .catch(() => null),
        pendingGiftPromise,
      ])
    }
    trialStatus = trialDisabledPublic
    trialWatchSettings = trialSettingsFallback
    plansRows = null
  } else if (!isActiveNow) {
    ;[modesPayload, plansRows] = await Promise.all([
      loadGlobalAppModesPayload().catch(() => modesFallback()),
      needsPlans ? billing.listActivePlansForVerify().catch(() => []) : Promise.resolve(null),
    ])
    txnSummary = null
    securityPolicy = null
    trialStatus = null
    pendingGift = null
    trialWatchSettings = trialSettingsFallback
    timing.inactive_fast_path = true
  } else {
    ;[
      txnSummary,
      modesPayload,
      securityPolicy,
      trialStatus,
      pendingGift,
      trialWatchSettings,
      plansRows,
    ] = await Promise.all([
      billing.getLatestCompletedSubscriptionTxnSummary(d),
      loadGlobalAppModesPayload().catch(() => modesFallback()),
      import('../lib/deviceSecurityStore.js')
        .then((m) => m.getPlaybackSecurityPolicy(d))
        .catch(() => null),
      getDeviceTrialWatchStatus(d, fp).catch(() => null),
      billing.getOldestPendingManualGrant(d),
      loadTrialWatchSettings().catch(() => trialSettingsFallback),
      needsPlans ? billing.listActivePlansForVerify().catch(() => []) : Promise.resolve(null),
    ])
  }
  timing.parallel_fetch_ms = Date.now() - tParallel0
  timing.active_fast_path = isActiveNow && !needsMigrationLink

  const normalized = normalizeVerifyResponse(pub, txnSummary)
  const runtimeModes = appModesForVerify(modesPayload)
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

  timing.total_ms = Date.now() - verifyT0
  const slowThreshold = verifySlowLogThresholdMs()
  if (timing.total_ms >= slowThreshold || timing.provider_polled) {
    const logFn = timing.total_ms >= slowThreshold ? console.warn : console.log
    const tag = timing.total_ms >= slowThreshold ? '[subscription-verify-slow]' : '[subscription-verify-timing]'
    logFn(tag, {
      ...timing,
      sonicpesa: pollDecision.provider === 'sonicpesa' || timing.poll_decision?.provider === 'sonicpesa',
      slow_reason:
        timing.total_ms >= slowThreshold
          ? timing.reconcile_ms >= 1000
            ? 'provider_reconcile'
            : timing.parallel_fetch_ms >= 1000
              ? 'parallel_db_fetch'
              : timing.access_ms >= 800
                ? 'subscription_access_query'
                : 'overall_latency'
          : undefined,
    })
  }

  if (!pub.active) {
    return {
      ...withGift,
      plans: mapVerifyPlans(plansRows),
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
    const deviceId = String(req.query.device_id ?? '').trim()
    const fp = String(req.query.fingerprint ?? req.headers['x-device-fingerprint'] ?? '').trim()
    const migration = migrationHintsFromPayload(req.query)
    const activeFb = await maybeActiveVerifyFallback(req, deviceId, fp, e)
    if (activeFb) return res.json(activeFb)
    const fb = await maybeInactiveVerifyFallback(
      req,
      verifyFallbackContext({
        deviceId,
        orderIdHint: String(req.query.order_id ?? '').trim(),
        fingerprint: fp,
        phone: String(req.query.payment_phone ?? req.query.phone ?? '').trim(),
        legacyDeviceId: migration.legacyDeviceId,
        accountId: migration.accountId,
      }),
      e,
    )
    if (fb) return res.json(fb)
    return respondSafeInactiveAfterVerifyError(req, res, deviceId, fp, 'subscription-status', e)
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
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const deviceId = String(b.device_id ?? b.deviceId ?? '').trim()
    const fp = String(
      b.device_fingerprint ?? b.fingerprint ?? b.deviceFingerprint ?? req.headers['x-device-fingerprint'] ?? '',
    ).trim()
    const migration = migrationHintsFromPayload(b)
    const activeFb = await maybeActiveVerifyFallback(req, deviceId, fp, e)
    if (activeFb) return res.json(activeFb)
    const fb = await maybeInactiveVerifyFallback(
      req,
      verifyFallbackContext({
        deviceId,
        orderIdHint: String(b.order_id ?? b.orderId ?? '').trim(),
        fingerprint: fp,
        phone: String(b.payment_phone ?? b.phone ?? b.paymentPhone ?? '').trim(),
        legacyDeviceId: migration.legacyDeviceId,
        accountId: migration.accountId,
      }),
      e,
    )
    if (fb) return res.json(fb)
    return respondSafeInactiveAfterVerifyError(req, res, deviceId, fp, 'subscription/verify', e)
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
  const channelRef = parseChannelRefFromRequest(req)
  const channelId = channelRef.channelId
  const channelName = channelRef.channelName
  void billing.touchLivePresence({ deviceId, country, channelId, channelName }).catch((e) => {
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
      active: pub.active === true,
      status: pub.status ?? null,
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
      inactive_reason: pub.inactive_reason ?? null,
      inactiveReason: pub.inactiveReason ?? null,
      admin_revoked: pub.admin_revoked === true,
      adminRevoked: pub.adminRevoked === true,
      suppress_expiry_popup: pub.suppress_expiry_popup === true,
      suppressExpiryPopup: pub.suppressExpiryPopup === true,
      entitlement_state: pub.entitlement_state ?? null,
      entitlementState: pub.entitlementState ?? null,
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
        // Never push inactive/revoked-shaped SSE on DB errors — client will keep last verify state.
        console.error('[subscription-stream] snapshot skipped on error:', e)
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

  const writePhoneGateEvent = async (reason) => {
    try {
      const p = await loadPhoneGatePublicPayload()
      const body = JSON.stringify({ ...p, reason })
      res.write(`event: phone_gate_settings\ndata: ${body}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] phone_gate_settings push failed:', e)
    }
  }
  void writePhoneGateEvent('init')

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
        bannerId: packet?.payload?.bannerId ?? null,
        channelId: packet?.payload?.channelId ?? packet?.payload?.channel?.id ?? null,
        channel: packet?.payload?.channel ?? null,
        catalog_revision: packet?.payload?.catalog_revision ?? null,
        updatedAt: packet?.payload?.updatedAt ?? packet?.payload?.synced_at ?? null,
        reason: event,
      })
      res.write(`event: catalog_refresh\ndata: ${body}\n\n`)
      if (event === 'config.channels_changed') {
        res.write(`event: channels_catalog\ndata: ${body}\n\n`)
        res.write(`event: channels_changed\ndata: ${body}\n\n`)
      }
      if (event === 'config.banners_changed') {
        res.write(`event: banners_changed\ndata: ${body}\n\n`)
        res.write(`event: banner_updated\ndata: ${body}\n\n`)
      }
      if (event === 'config.plans_changed') {
        res.write(`event: plans_changed\ndata: ${body}\n\n`)
      }
    } catch (e) {
      console.error('[subscription-stream] catalog refresh push failed:', e)
    }
  }

  const phoneGateSyncHandler = (packet) => {
    if (String(packet?.event || '') !== 'phone_gate_changed') return
    try {
      const enabled = packet?.payload?.phone_gate_enabled === true
      const body = JSON.stringify({
        ok: true,
        v: packet.configVersion,
        phone_gate_enabled: enabled,
        phoneGateEnabled: enabled,
        reason: 'phone_gate_changed',
        server_time_ms: Date.now(),
      })
      res.write(`event: phone_gate_settings\ndata: ${body}\n\n`)
    } catch (e) {
      console.error('[subscription-stream] phone_gate immediate push failed:', e)
    }
  }

  liveSyncBus.on('sync', modeSyncHandler)
  liveSyncBus.on('sync', trialSyncHandler)
  liveSyncBus.on('sync', appUpdateSyncHandler)
  liveSyncBus.on('sync', catalogSyncHandler)
  liveSyncBus.on('sync', phoneGateSyncHandler)

  const writeManualGiftEvent = (manualGift) => {
    if (!manualGift?.showPopup) return
    writeManualGrantSseEvents(res, manualGift)
  }

  const handler = async (payload) => {
    if (!payload || payload.deviceId !== deviceId) return
    try {
      invalidateSubscriptionAccessCache(deviceId)
      const fp = String(req.query.fingerprint ?? req.headers['x-device-fingerprint'] ?? '').trim()
      const row = await billing.getDeviceSubscriptionAccessState(deviceId, fp)
      const sseBody = JSON.stringify(toSsePayload(row))
      res.write(`event: device_subscription\ndata: ${sseBody}\n\n`)
      const isAdminRevoke =
        payload?.adminRevoked === true ||
        payload?.reason === 'admin_revoked' ||
        String(row?.status ?? '').toLowerCase() === 'revoked' ||
        row?.admin_revoked_at != null
      if (isAdminRevoke) {
        writeAdminRevokedSseEvents(res, { device_id: deviceId })
      } else {
        writeSubscriptionWakeSseEvents(res, {
          reason: payload?.reason ?? 'device_subscription',
          grantId: null,
        })
      }
      flushSseResponse(res)
    } catch (e) {
      // Skip SSE push on read failure — avoids defaulting clients to revoked/inactive.
      console.error('[subscription-stream] device_subscription skipped on error:', e)
    }
  }

  const manualGiftHandler = (payload) => {
    if (!payload || payload.deviceId !== deviceId) return
    try {
      writeManualGiftEvent(payload.manualGift)
    } catch (e) {
      console.error('[subscription-stream] manual_gift push failed:', e)
    }
  }

  const subscriptionUpdatedSyncHandler = (packet) => {
    if (String(packet?.event || '') !== 'analytics.subscription_updated') return
    const did = String(packet?.payload?.deviceId ?? '').trim()
    if (!did || did !== deviceId) return
    try {
      writeManualGiftEvent(packet?.payload?.manualGift)
    } catch (e) {
      console.error('[subscription-stream] relayed manual_gift push failed:', e)
    }
    const reason = String(packet?.payload?.reason ?? '')
    void handler({
      deviceId: did,
      reason,
      adminRevoked: reason === 'admin_revoke' || reason === 'admin_revoked',
    })
  }

  const subscriptionRevokedSyncHandler = (packet) => {
    if (String(packet?.event || '') !== 'subscription_revoked') return
    const did = String(packet?.payload?.device_id ?? packet?.payload?.deviceId ?? '').trim()
    if (!did || did !== deviceId) return
    void handler({ deviceId: did, reason: 'admin_revoked', adminRevoked: true })
  }
  liveSyncBus.on('sync', subscriptionUpdatedSyncHandler)
  liveSyncBus.on('sync', subscriptionRevokedSyncHandler)

  const modePoll = setInterval(() => {
    void writeAppModesEvent('poll')
    void writePhoneGateEvent('poll')
    void writeTrialWatchEvent('poll')
    void writeAppUpdateEvent('poll')
  }, MODE_SSE_POLL_MS)

  deviceSubscriptionBus.on('update', handler)
  deviceSubscriptionBus.on('manual_gift', manualGiftHandler)

  const ping = setInterval(() => {
    res.write(': ping\n\n')
    const liveRef = parseChannelRefFromRequest(req)
    void billing
      .touchLivePresence({
        deviceId,
        country,
        channelId: liveRef.channelId,
        channelName: liveRef.channelName,
      })
      .catch((e) => {
        console.error('[subscription-stream] presence ping failed:', e)
      })
    liveSyncBus.publish('analytics.session_heartbeat', { topics: ['analytics'], deviceId })
  }, 20_000)

  req.on('close', () => {
    clearInterval(ping)
    clearInterval(modePoll)
    deviceSubscriptionBus.off('update', handler)
    deviceSubscriptionBus.off('manual_gift', manualGiftHandler)
    liveSyncBus.off('sync', modeSyncHandler)
    liveSyncBus.off('sync', trialSyncHandler)
    liveSyncBus.off('sync', appUpdateSyncHandler)
    liveSyncBus.off('sync', catalogSyncHandler)
    liveSyncBus.off('sync', phoneGateSyncHandler)
    liveSyncBus.off('sync', subscriptionUpdatedSyncHandler)
    liveSyncBus.off('sync', subscriptionRevokedSyncHandler)
    try {
      res.end()
    } catch (e) {
      console.error('[subscription-stream] close res.end failed:', e)
    }
  })
})
