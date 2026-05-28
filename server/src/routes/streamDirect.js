import { Router } from 'express'
import { verifyDirectStreamToken } from '../lib/directStreamSigning.js'
import { recordDirectRequest } from '../lib/streamDeliveryMetrics.js'
import { resolveManifestRewriteUrlBuilder } from '../lib/streamSegmentDelivery.js'
import { runStreamProxyRequest } from './streamProxy.js'

export const streamDirectRouter = Router()

/**
 * Token-gated manifest entry. Segment lines rewrite to Bunny CDN (signed) when enabled, else stream-proxy.
 */
streamDirectRouter.get('/stream-direct', async (req, res) => {
  const verified = verifyDirectStreamToken(req.query.token)
  if (!verified.ok) {
    return res.status(verified.status).json({ error: verified.error })
  }
  const { upstreamUrl, referer, origin, userAgent, channelId } = verified.payload
  res.setHeader('X-Stream-Delivery', 'direct')
  res.setHeader('X-Stream-Channel-Id', channelId || '')
  const manifestRewriteUrlBuilder = resolveManifestRewriteUrlBuilder(req, { channelId })
  return runStreamProxyRequest(req, res, {
    sourceUrl: upstreamUrl,
    upstreamHeaders: { referer, origin, userAgent },
    mountPath: 'stream-direct',
    channelId,
    manifestRewriteUrlBuilder,
  })
})
