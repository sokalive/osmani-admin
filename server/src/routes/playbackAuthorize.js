import { Router } from 'express'
import { channelToResponse, isInstructionVideoChannelRow } from '../channelNormalize.js'
import { getChannelById } from '../store.js'
import { extractVersionCodeFromRequest } from '../lib/clientApiTelemetry.js'
import {
  channelRequiresPremiumEntitlement,
  extractDeviceIdFromRequest,
  isPremiumEnforcementHard,
  markChannelAuthorized,
  PREMIUM_ALLOW_REASONS,
  PREMIUM_DENY_REASONS,
  redactPremiumChannelUrls,
  resolvePremiumPlaybackEntitlement,
} from '../lib/playbackEntitlementGate.js'
import { createPlaybackGrant, playbackGrantTtlSec } from '../lib/playbackGrant.js'
import { auditPremiumPlaybackAccess } from '../lib/premiumPlaybackAudit.js'
import {
  buildSignedDirectStreamPlaybackUrl,
  isDirectStreamSigningConfigured,
} from '../lib/directStreamSigning.js'

export const playbackAuthorizeRouter = Router()

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? '')
    .split(',')[0]
    .trim()
    .slice(0, 64)
}

/**
 * POST /api/playback/authorize
 * Body: { device_id, channel_id? }
 * Returns short-lived grant + optional channel playback payload when entitled.
 */
playbackAuthorizeRouter.post('/playback/authorize', async (req, res) => {
  try {
    const deviceId = extractDeviceIdFromRequest(req)
    const channelId = req.body?.channel_id ?? req.body?.channelId ?? req.query?.channel_id
    const entitlement = await resolvePremiumPlaybackEntitlement(deviceId)

    if (!entitlement.allowed) {
      auditPremiumPlaybackAccess({
        deviceId,
        channelId: channelId != null ? String(channelId) : '',
        decision: 'denied',
        reason: entitlement.reason,
        path: '/api/playback/authorize',
        ip: clientIp(req),
        metadata: {
          subscription_active: entitlement.subscription_active,
          security_denied: entitlement.security_denied,
        },
      })
      return res.status(403).json({
        ok: false,
        allowed: false,
        reason: entitlement.reason,
        playbackAllowed: false,
        playback_gate_reason: entitlement.reason,
        device_id: deviceId || null,
      })
    }

    const grant = createPlaybackGrant({
      deviceId,
      channelId,
      reason: entitlement.reason,
    })

    let channel = null
    if (channelId != null && String(channelId).trim()) {
      const row = await getChannelById(channelId)
      if (row) {
        const clientVersion = extractVersionCodeFromRequest(req)
        let api = channelToResponse(row, req, clientVersion)
        if (channelRequiresPremiumEntitlement(row) || channelRequiresPremiumEntitlement(api)) {
          api = markChannelAuthorized(api, entitlement.reason)
          if (isDirectStreamSigningConfigured() && String(row.url || '').trim()) {
            const boundUrl = buildSignedDirectStreamPlaybackUrl(
              req,
              String(row.url),
              { referer: row.referer, origin: row.origin, userAgent: row.userAgent },
              { channelId: row.id, deviceId },
            )
            if (boundUrl) {
              api = {
                ...api,
                playbackUrl: boundUrl,
                stream_url: boundUrl,
                streamUrl: boundUrl,
                direct_stream_url: boundUrl,
              }
            }
          }
        } else {
          api = markChannelAuthorized(api, PREMIUM_ALLOW_REASONS.FREE_CONTENT)
        }
        channel = api
      }
    }

    auditPremiumPlaybackAccess({
      deviceId,
      channelId: channelId != null ? String(channelId) : '',
      decision: 'allowed',
      reason: entitlement.reason,
      path: '/api/playback/authorize',
      ip: clientIp(req),
    })

    return res.json({
      ok: true,
      allowed: true,
      reason: entitlement.reason,
      playbackAllowed: true,
      playback_gate_reason: entitlement.reason,
      device_id: deviceId,
      expires_at: entitlement.expires_at,
      grant: grant.ok ? grant.grant : null,
      grant_expires_at: grant.ok ? grant.expires_at : null,
      grant_ttl_sec: grant.ok ? grant.ttl_sec : playbackGrantTtlSec(),
      channel,
    })
  } catch (e) {
    console.error('[playback/authorize]', e)
    return res.status(500).json({
      ok: false,
      allowed: false,
      reason: PREMIUM_DENY_REASONS.MALFORMED_ENTITLEMENT,
      error: String(e.message || e),
    })
  }
})

/**
 * GET /api/playback/entitlement?device_id=
 * Lightweight entitlement check (no grant).
 */
playbackAuthorizeRouter.get('/playback/entitlement', async (req, res) => {
  try {
    const deviceId = extractDeviceIdFromRequest(req)
    const entitlement = await resolvePremiumPlaybackEntitlement(deviceId)
    return res.json({
      ok: true,
      ...entitlement,
      playbackAllowed: entitlement.allowed,
      playback_gate_reason: entitlement.reason,
      enforcement_mode: process.env.SERVER_PREMIUM_ENFORCEMENT || 'enforce',
    })
  } catch (e) {
    console.error('[playback/entitlement]', e)
    return res.status(500).json({ ok: false, allowed: false, error: String(e.message || e) })
  }
})

/**
 * Apply entitlement redaction to a list of API channel objects.
 * Used by GET /api/channels.
 */
export async function applyPremiumEntitlementToChannelList(req, apiChannels, dbChannels) {
  if (!isPremiumEnforcementHard() && String(process.env.SERVER_PREMIUM_ENFORCEMENT || '').toLowerCase() !== 'shadow') {
    return apiChannels
  }

  const deviceId = extractDeviceIdFromRequest(req)
  const entitlement = deviceId
    ? await resolvePremiumPlaybackEntitlement(deviceId)
    : {
        allowed: false,
        reason: PREMIUM_DENY_REASONS.MISSING_DEVICE_ID,
        subscription_active: false,
        security_denied: false,
      }

  const byId = new Map()
  for (const row of dbChannels || []) {
    byId.set(String(row.id), row)
  }

  let deniedCount = 0
  let allowedCount = 0
  const out = apiChannels.map((api, idx) => {
    const row = byId.get(String(api.id)) || dbChannels?.[idx] || api
    if (isInstructionVideoChannelRow(row) || !channelRequiresPremiumEntitlement(row)) {
      return markChannelAuthorized(api, PREMIUM_ALLOW_REASONS.FREE_CONTENT)
    }
    if (entitlement.allowed) {
      allowedCount += 1
      return markChannelAuthorized(api, entitlement.reason)
    }
    deniedCount += 1
    if (isPremiumEnforcementHard()) {
      return redactPremiumChannelUrls(api, entitlement.reason)
    }
    // shadow: leave URLs but annotate
    return {
      ...api,
      playback_authorized: false,
      access_denied: true,
      access_deny_reason: entitlement.reason,
      _shadow_would_redact: true,
    }
  })

  if (deniedCount > 0 || allowedCount > 0) {
    auditPremiumPlaybackAccess({
      deviceId: deviceId || '',
      decision: entitlement.allowed ? 'allowed' : 'denied',
      reason: entitlement.reason,
      path: '/api/channels',
      ip: clientIp(req),
      metadata: {
        denied_premium_channels: deniedCount,
        allowed_premium_channels: allowedCount,
        mode: process.env.SERVER_PREMIUM_ENFORCEMENT || 'enforce',
      },
    })
  }

  return out
}
