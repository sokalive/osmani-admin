/**
 * Authoritative server-side premium playback entitlement.
 * Consumes existing subscription SoT + security policy. Does NOT touch payments.
 *
 * Decision reasons (stable codes for audits / Admin):
 * - allowed: active_subscription | free_mode | trial_watch_active | free_content
 * - denied: no_active_subscription | subscription_expired | subscription_inactive |
 *           subscription_revoked | admin_blocked | security_policy_denied |
 *           emergency_mode | maintenance_mode | missing_device_id | malformed_entitlement
 */

import * as billing from '../billingStore.js'
import { getPlaybackSecurityPolicy } from './deviceSecurityStore.js'
import { loadGlobalAppModesPayload } from '../routes/globalAppSettings.js'

export const PREMIUM_DENY_REASONS = Object.freeze({
  NO_ACTIVE_SUBSCRIPTION: 'no_active_subscription',
  SUBSCRIPTION_EXPIRED: 'subscription_expired',
  SUBSCRIPTION_INACTIVE: 'subscription_inactive',
  SUBSCRIPTION_REVOKED: 'subscription_revoked',
  ADMIN_BLOCKED: 'admin_blocked',
  SECURITY_POLICY_DENIED: 'security_policy_denied',
  EMERGENCY_MODE: 'emergency_mode',
  MAINTENANCE_MODE: 'maintenance_mode',
  MISSING_DEVICE_ID: 'missing_device_id',
  MALFORMED_ENTITLEMENT: 'malformed_entitlement',
  STALE_OR_INVALID_GRANT: 'stale_or_invalid_playback_authorization',
})

export const PREMIUM_ALLOW_REASONS = Object.freeze({
  ACTIVE_SUBSCRIPTION: 'active_subscription',
  FREE_MODE: 'free_mode',
  TRIAL_WATCH_ACTIVE: 'trial_watch_active',
  FREE_CONTENT: 'free_content',
})

/** enforce | shadow | off */
export function premiumEnforcementMode() {
  const v = String(process.env.SERVER_PREMIUM_ENFORCEMENT ?? 'enforce')
    .trim()
    .toLowerCase()
  if (v === 'off' || v === 'shadow' || v === 'legacy') return v === 'legacy' ? 'off' : v
  return 'enforce'
}

export function isPremiumEnforcementActive() {
  const m = premiumEnforcementMode()
  return m === 'enforce' || m === 'shadow'
}

export function isPremiumEnforcementHard() {
  return premiumEnforcementMode() === 'enforce'
}

export function extractDeviceIdFromRequest(req) {
  if (!req) return ''
  const h =
    req.headers?.['x-device-id'] ||
    req.headers?.['x-osmani-device-id'] ||
    req.headers?.['x-osmani-deviceid'] ||
    ''
  const q = req.query?.device_id ?? req.query?.deviceId ?? ''
  const b =
    req.body && typeof req.body === 'object'
      ? req.body.device_id ?? req.body.deviceId ?? ''
      : ''
  return String(h || q || b || '')
    .trim()
    .slice(0, 128)
}

function isRowActive(row) {
  if (!row) return false
  if (row.blocked_now === true) return false
  if (row.admin_revoked_at) return false
  if (String(row.status || '').toLowerCase() === 'revoked') return false
  return row.active_now === true && String(row.status || '').toLowerCase() === 'active'
}

function classifyInactiveReason(row) {
  if (!row) return PREMIUM_DENY_REASONS.NO_ACTIVE_SUBSCRIPTION
  if (row.blocked_now === true) return PREMIUM_DENY_REASONS.ADMIN_BLOCKED
  if (row.admin_revoked_at || String(row.status || '').toLowerCase() === 'revoked') {
    return PREMIUM_DENY_REASONS.SUBSCRIPTION_REVOKED
  }
  if (String(row.status || '').toLowerCase() === 'active' && row.active_now !== true) {
    return PREMIUM_DENY_REASONS.SUBSCRIPTION_EXPIRED
  }
  if (row.status && String(row.status).toLowerCase() !== 'active') {
    return PREMIUM_DENY_REASONS.SUBSCRIPTION_INACTIVE
  }
  return PREMIUM_DENY_REASONS.NO_ACTIVE_SUBSCRIPTION
}

/**
 * Resolve whether a device may access premium protected content.
 * Client premium flags are intentionally ignored.
 *
 * @param {string} deviceId
 * @param {{ skipSecurity?: boolean, trialPlaybackAllowed?: boolean, trialReason?: string }} [opts]
 */
export async function resolvePremiumPlaybackEntitlement(deviceId, opts = {}) {
  const d = String(deviceId ?? '').trim().slice(0, 128)
  if (!d) {
    return {
      allowed: false,
      reason: PREMIUM_DENY_REASONS.MISSING_DEVICE_ID,
      subscription_active: false,
      security_denied: false,
      device_id: '',
      expires_at: null,
      trust_state: null,
    }
  }

  let modes = { free_mode: false, emergency_mode: false, maintenance_mode: false }
  try {
    const payload = await loadGlobalAppModesPayload()
    modes = {
      free_mode: payload?.free_mode === true,
      emergency_mode: payload?.emergency_mode === true,
      maintenance_mode: payload?.maintenance_mode === true,
    }
  } catch {
    /* fail-closed for uncertainty on modes load is too harsh for free_mode; treat as not free */
  }

  if (modes.emergency_mode) {
    return {
      allowed: false,
      reason: PREMIUM_DENY_REASONS.EMERGENCY_MODE,
      subscription_active: false,
      security_denied: false,
      device_id: d,
      expires_at: null,
      trust_state: null,
    }
  }
  if (modes.maintenance_mode) {
    return {
      allowed: false,
      reason: PREMIUM_DENY_REASONS.MAINTENANCE_MODE,
      subscription_active: false,
      security_denied: false,
      device_id: d,
      expires_at: null,
      trust_state: null,
    }
  }

  let row = null
  try {
    row = await billing.getDeviceSubscriptionAccessStateFast(d)
  } catch (e) {
    console.error('[playback-entitlement] subscription lookup failed:', e)
    return {
      allowed: false,
      reason: PREMIUM_DENY_REASONS.MALFORMED_ENTITLEMENT,
      subscription_active: false,
      security_denied: false,
      device_id: d,
      expires_at: null,
      trust_state: null,
    }
  }

  const subscriptionActive = isRowActive(row)
  const expiresAt =
    row?.expires_at instanceof Date
      ? row.expires_at.toISOString()
      : row?.expires_at
        ? String(row.expires_at)
        : null

  let securityDenied = false
  let trustState = null
  let securityReason = ''
  if (!opts.skipSecurity) {
    try {
      const policy = await getPlaybackSecurityPolicy(d)
      if (policy?.deny_playback === true && policy?.whitelisted !== true) {
        securityDenied = true
        securityReason = String(policy.playback_gate_reason || 'security_blocked')
        trustState = policy.trust_state || null
      } else if (policy?.whitelisted === true) {
        trustState = 'whitelisted'
      } else {
        trustState = policy?.trust_state || null
      }
    } catch (e) {
      console.error('[playback-entitlement] security policy failed:', e)
      // Fail closed on security lookup uncertainty for premium
      securityDenied = true
      securityReason = 'security_policy_unavailable'
    }
  }

  if (securityDenied) {
    return {
      allowed: false,
      reason: PREMIUM_DENY_REASONS.SECURITY_POLICY_DENIED,
      subscription_active: subscriptionActive,
      security_denied: true,
      security_reason: securityReason,
      device_id: d,
      expires_at: expiresAt,
      trust_state: trustState,
    }
  }

  if (subscriptionActive) {
    return {
      allowed: true,
      reason: PREMIUM_ALLOW_REASONS.ACTIVE_SUBSCRIPTION,
      subscription_active: true,
      security_denied: false,
      device_id: d,
      expires_at: expiresAt,
      trust_state: trustState,
    }
  }

  if (modes.free_mode) {
    return {
      allowed: true,
      reason: PREMIUM_ALLOW_REASONS.FREE_MODE,
      subscription_active: false,
      security_denied: false,
      device_id: d,
      expires_at: expiresAt,
      trust_state: trustState,
    }
  }

  if (opts.trialPlaybackAllowed === true) {
    return {
      allowed: true,
      reason: opts.trialReason || PREMIUM_ALLOW_REASONS.TRIAL_WATCH_ACTIVE,
      subscription_active: false,
      security_denied: false,
      device_id: d,
      expires_at: expiresAt,
      trust_state: trustState,
    }
  }

  return {
    allowed: false,
    reason: classifyInactiveReason(row),
    subscription_active: false,
    security_denied: false,
    device_id: d,
    expires_at: expiresAt,
    trust_state: trustState,
  }
}

/** Free / instruction channels are not gated by subscription. */
export function channelRequiresPremiumEntitlement(channel) {
  if (!channel || typeof channel !== 'object') return true
  const kind = String(channel.channelKind || channel.channel_kind || '').toLowerCase()
  if (kind === 'instruction' || kind === 'instruction_video') return false
  const accessType = String(channel.accessType || channel.access_type || '').toLowerCase()
  if (accessType === 'free') return false
  if (channel.accessPremium === false && accessType !== 'premium') return false
  if (channel.access_premium === false && accessType !== 'premium') return false
  if (accessType === 'premium' || channel.accessPremium === true || channel.access_premium === true) {
    return true
  }
  // Default: treat unknown as premium (fail closed for protected content)
  return true
}

export function redactPremiumChannelUrls(apiChannel, denyReason) {
  if (!apiChannel || typeof apiChannel !== 'object') return apiChannel
  return {
    ...apiChannel,
    url: '',
    playbackUrl: '',
    stream_url: '',
    streamUrl: '',
    proxy_playback_url: '',
    proxyPlaybackUrl: '',
    direct_stream_url: '',
    directStreamUrl: '',
    backupPlayback1: '',
    backupPlayback2: '',
    direct_stream_url_backup1: '',
    direct_stream_url_backup2: '',
    playback_authorized: false,
    access_denied: true,
    access_deny_reason: denyReason || PREMIUM_DENY_REASONS.NO_ACTIVE_SUBSCRIPTION,
  }
}

export function markChannelAuthorized(apiChannel, allowReason) {
  if (!apiChannel || typeof apiChannel !== 'object') return apiChannel
  return {
    ...apiChannel,
    playback_authorized: true,
    access_denied: false,
    access_deny_reason: null,
    access_allow_reason: allowReason || PREMIUM_ALLOW_REASONS.ACTIVE_SUBSCRIPTION,
  }
}
