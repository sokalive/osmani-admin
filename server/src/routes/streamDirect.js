import { Router } from 'express'
import { PROXY_MOUNT_STREAM } from './streamProxy.js'
import { verifyDirectStreamToken } from '../lib/directStreamSigning.js'
import { recordDirectRequest } from '../lib/streamDeliveryMetrics.js'
import { runStreamProxyRequest } from './streamProxy.js'

export const streamDirectRouter = Router()

/**
 * Token-gated manifest entry. HLS segment lines use stream-proxy URLs (stable playback).
 */
streamDirectRouter.get('/stream-direct', async (req, res) => {
  const verified = verifyDirectStreamToken(req.query.token)
  if (!verified.ok) {
    return res.status(verified.status).json({ error: verified.error })
  }
  const { upstreamUrl, referer, origin, userAgent, channelId } = verified.payload
  res.setHeader('X-Stream-Delivery', 'direct')
  res.setHeader('X-Stream-Channel-Id', channelId || '')
  return runStreamProxyRequest(req, res, {
    sourceUrl: upstreamUrl,
    upstreamHeaders: { referer, origin, userAgent },
    mountPath: 'stream-direct',
    manifestRewriteMount: PROXY_MOUNT_STREAM,
  })
})
