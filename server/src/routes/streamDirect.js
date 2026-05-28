import { Router } from 'express'
import { verifyDirectStreamToken } from '../lib/directStreamSigning.js'
import { runStreamProxyRequest } from './streamProxy.js'

export const streamDirectRouter = Router()

/**
 * Token-gated stream entry (foundation). Validates HMAC token then uses the same
 * proxy fetch/rewrite path as /stream-proxy. Existing clients keep using /stream-proxy.
 */
streamDirectRouter.get('/stream-direct', async (req, res) => {
  const verified = verifyDirectStreamToken(req.query.token)
  if (!verified.ok) {
    return res.status(verified.status).json({ error: verified.error })
  }
  const { upstreamUrl, referer, origin, userAgent } = verified.payload
  return runStreamProxyRequest(req, res, {
    sourceUrl: upstreamUrl,
    upstreamHeaders: { referer, origin, userAgent },
    mountPath: 'stream-direct',
  })
})
