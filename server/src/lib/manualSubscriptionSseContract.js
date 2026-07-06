/**
 * Cross-AI SSE contract for manual subscription wake + gift delivery.
 * App commit af1b108+ listens on /api/subscription-stream and re-runs verify on wake.
 * Verify (POST /api/subscription/verify) remains authoritative for unlock + manualGift.
 */

/** Events that tell the client to call reverifySubscription() immediately. */
export const SUBSCRIPTION_WAKE_SSE_EVENTS = Object.freeze([
  'subscription_wake',
  'device_subscription_updated',
])

/** Alias events carrying manual gift popup hint (same JSON body). */
export const MANUAL_SUBSCRIPTION_SSE_ALIASES = Object.freeze([
  'manual_gift',
  'manual_subscription_granted',
  'subscription_manual_grant',
])

export function buildManualGiftSseBody(manualGift) {
  return JSON.stringify({
    ok: true,
    manualGift,
    manual_gift_ack_key: String(manualGift?.grantId ?? ''),
    manualGiftAckKey: String(manualGift?.grantId ?? ''),
    reason: 'manual_grant_activated',
    requires_verify: true,
    server_time_ms: Date.now(),
  })
}

export function buildSubscriptionWakeSseBody({ grantId = null, reason = 'manual_grant_activated' } = {}) {
  return JSON.stringify({
    ok: true,
    reason,
    requires_verify: true,
    grantId: grantId != null ? Number(grantId) : null,
    server_time_ms: Date.now(),
  })
}

/** Write canonical + alias manual gift events and wake events to an open SSE response. */
export function writeManualGrantSseEvents(res, manualGift) {
  if (!manualGift?.showPopup) return
  const giftBody = buildManualGiftSseBody(manualGift)
  for (const event of MANUAL_SUBSCRIPTION_SSE_ALIASES) {
    res.write(`event: ${event}\ndata: ${giftBody}\n\n`)
  }
  const wakeBody = buildSubscriptionWakeSseBody({
    grantId: manualGift.grantId,
    reason: 'manual_grant_activated',
  })
  for (const event of SUBSCRIPTION_WAKE_SSE_EVENTS) {
    res.write(`event: ${event}\ndata: ${wakeBody}\n\n`)
  }
}

/** Wake-only events after device_subscription state push (no popup payload). */
export function writeSubscriptionWakeSseEvents(res, { grantId = null, reason = 'device_subscription' } = {}) {
  const wakeBody = buildSubscriptionWakeSseBody({ grantId, reason })
  for (const event of SUBSCRIPTION_WAKE_SSE_EVENTS) {
    res.write(`event: ${event}\ndata: ${wakeBody}\n\n`)
  }
}

/** Admin revocation — explicit semantics so App suppresses natural-expiry popup (Kifurushi kimekwisha). */
export function buildAdminRevokedSseBody(extra = {}) {
  return JSON.stringify({
    ok: true,
    reason: 'admin_revoked',
    inactive_reason: 'admin_revoked',
    admin_revoked: true,
    suppress_expiry_popup: true,
    entitlement_state: 'revoked',
    requires_verify: true,
    server_time_ms: Date.now(),
    ...extra,
  })
}

export function writeAdminRevokedSseEvents(res, extra = {}) {
  const body = buildAdminRevokedSseBody(extra)
  res.write(`event: subscription_revoked\ndata: ${body}\n\n`)
  res.write(`event: subscription_wake\ndata: ${body}\n\n`)
  res.write(`event: device_subscription_updated\ndata: ${body}\n\n`)
}
