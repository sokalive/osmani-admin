/**
 * Shared stream-edge entitlement enforcement for /stream-direct and /stream-proxy.
 */
import {
  extractDeviceIdFromRequest,
  isPremiumEnforcementHard,
  PREMIUM_DENY_REASONS,
  resolvePremiumPlaybackEntitlement,
} from './playbackEntitlementGate.js'
import { verifyPlaybackGrant } from './playbackGrant.js'
import { auditPremiumPlaybackAccess } from './premiumPlaybackAudit.js'
import { isKnownPremiumUpstreamUrl } from './premiumUpstreamRegistry.js'

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '')
    .split(',')[0]
    .trim()
    .slice(0, 64)
}

/**
 * @returns {Promise<{ ok: true } | { ok: false, status: number, error: string, code: string }>}
 */
export async function enforcePremiumStreamAccess(req, opts = {}) {
  if (!isPremiumEnforcementHard()) {
    return { ok: true }
  }

  const upstreamUrl = String(opts.upstreamUrl || '').trim()
  const tokenDeviceId = String(opts.tokenDeviceId || '').trim()
  const channelId = opts.channelId != null ? String(opts.channelId) : ''

  // Non-premium / unknown upstreams: allow (free content, CDN assets, etc.)
  const isPremium = upstreamUrl ? await isKnownPremiumUpstreamUrl(upstreamUrl) : Boolean(opts.forcePremium)
  if (!isPremium && !opts.forcePremium) {
    return { ok: true }
  }

  const grantRaw =
    req.query?.playback_grant ||
    req.query?.grant ||
    req.headers?.['x-playback-grant'] ||
    ''
  if (grantRaw) {
    const verified = verifyPlaybackGrant(grantRaw, {
      expectedDeviceId: tokenDeviceId || extractDeviceIdFromRequest(req) || undefined,
      expectedChannelId: channelId || undefined,
    })
    if (verified.ok) {
      // Re-check live entitlement (grant alone is not enough after expiry)
      const ent = await resolvePremiumPlaybackEntitlement(verified.payload.device_id)
      if (ent.allowed) {
        auditPremiumPlaybackAccess({
          deviceId: verified.payload.device_id,
          channelId,
          decision: 'allowed',
          reason: ent.reason,
          path: opts.path || 'stream',
          ip: clientIp(req),
          metadata: { via: 'playback_grant' },
        })
        return { ok: true }
      }
      auditPremiumPlaybackAccess({
        deviceId: verified.payload.device_id,
        channelId,
        decision: 'denied',
        reason: ent.reason,
        path: opts.path || 'stream',
        ip: clientIp(req),
        metadata: { via: 'playback_grant_stale' },
      })
      return {
        ok: false,
        status: 403,
        error: `Premium playback denied: ${ent.reason}`,
        code: ent.reason,
      }
    }
  }

  const deviceId = tokenDeviceId || extractDeviceIdFromRequest(req)
  if (!deviceId) {
    auditPremiumPlaybackAccess({
      deviceId: '',
      channelId,
      decision: 'denied',
      reason: PREMIUM_DENY_REASONS.MISSING_DEVICE_ID,
      path: opts.path || 'stream',
      ip: clientIp(req),
      metadata: { upstream_host: (() => { try { return new URL(upstreamUrl).host } catch { return '' } })() },
    })
    return {
      ok: false,
      status: 403,
      error: 'Premium playback requires device entitlement',
      code: PREMIUM_DENY_REASONS.MISSING_DEVICE_ID,
    }
  }

  const ent = await resolvePremiumPlaybackEntitlement(deviceId)
  if (!ent.allowed) {
    auditPremiumPlaybackAccess({
      deviceId,
      channelId,
      decision: 'denied',
      reason: ent.reason,
      path: opts.path || 'stream',
      ip: clientIp(req),
    })
    return {
      ok: false,
      status: 403,
      error: `Premium playback denied: ${ent.reason}`,
      code: ent.reason,
    }
  }

  auditPremiumPlaybackAccess({
    deviceId,
    channelId,
    decision: 'allowed',
    reason: ent.reason,
    path: opts.path || 'stream',
    ip: clientIp(req),
  })
  return { ok: true }
}
