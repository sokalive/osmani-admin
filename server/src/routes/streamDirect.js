import { Router } from 'express'
import { verifyDirectStreamToken } from '../lib/directStreamSigning.js'
import { recordDirectRequest } from '../lib/streamDeliveryMetrics.js'
import { resolveManifestRewriteUrlBuilder } from '../lib/streamSegmentDelivery.js'
import { runStreamProxyRequest } from './streamProxy.js'

export const streamDirectRouter = Router()

/**
 * Token-gated manifest entry. Segment lines rewrite to Bunny CDN (signed) when enabled, else stream-proxy.
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
    const { upstreamUrl, referer, origin, userAgent, channelId } = verified.payload
    res.setHeader('X-Stream-Delivery', 'direct')
    res.setHeader('X-Stream-Channel-Id', channelId || '')
    const channelHeaders = { referer, origin, userAgent }
    const manifestRewriteUrlBuilder = resolveManifestRewriteUrlBuilder(req, {
      channelId,
      channelHeaders,
      rootUpstreamUrl: upstreamUrl,
    })
    return runStreamProxyRequest(req, res, {
      sourceUrl: upstreamUrl,
      upstreamHeaders: channelHeaders,
      mountPath: 'stream-direct',
      channelId,
      rootUpstreamUrl: upstreamUrl,
      manifestRewriteUrlBuilder,
    })
  }),
)
