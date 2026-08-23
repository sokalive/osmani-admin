import { Router } from 'express'
import { verifyDirectStreamToken } from '../lib/directStreamSigning.js'
import { recordDirectRequest } from '../lib/streamDeliveryMetrics.js'
import { resolveManifestRewriteUrlBuilder } from '../lib/streamSegmentDelivery.js'
import { runStreamProxyRequest } from './streamProxy.js'
import { enforcePremiumStreamAccess } from '../lib/streamEntitlementEnforce.js'

export const streamDirectRouter = Router()

/**
 * Token-gated manifest entry. Segment lines rewrite to Bunny CDN (signed) when enabled, else stream-proxy.
 * Premium upstreams also require live device entitlement (or valid playback grant).
 */
function wrapAsyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res)).catch(next)
  }
}

streamDirectRouter.get(
  '/stream-direct',
  wrapAsyncRoute(async (req, res) => {
    const verified = verifyDirectStreamToken(req.query.token)
    if (!verified.ok) {
      return res.status(verified.status).json({ error: verified.error })
    }
    const { upstreamUrl, referer, origin, userAgent, channelId, deviceId } = verified.payload

    const gate = await enforcePremiumStreamAccess(req, {
      upstreamUrl,
      channelId,
      tokenDeviceId: deviceId,
      path: '/stream-direct',
    })
    if (!gate.ok) {
      return res.status(gate.status).json({ ok: false, error: gate.error, code: gate.code })
    }

    res.setHeader('X-Stream-Delivery', 'direct')
    res.setHeader('X-Stream-Channel-Id', channelId || '')
    const channelHeaders = { referer, origin, userAgent }
    const manifestRewriteUrlBuilder = resolveManifestRewriteUrlBuilder(req, {
      channelId,
      channelHeaders,
      rootUpstreamUrl: upstreamUrl,
      deviceId,
    })
    return runStreamProxyRequest(req, res, {
      sourceUrl: upstreamUrl,
      upstreamHeaders: channelHeaders,
      mountPath: 'stream-direct',
      channelId,
      rootUpstreamUrl: upstreamUrl,
      manifestRewriteUrlBuilder,
      entitlementAlreadyChecked: true,
    })
  }),
)
