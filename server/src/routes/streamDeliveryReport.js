import { Router } from 'express'
import { recordClientFallbackReported } from '../lib/streamDeliveryMetrics.js'

export const streamDeliveryReportRouter = Router()

/**
 * Optional client/runtime report when direct playback fails and app falls back to proxy URL.
 * Does not affect auth — analytics-friendly counter only.
 */
streamDeliveryReportRouter.post('/stream-delivery/fallback', (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  recordClientFallbackReported()
  res.setHeader('Cache-Control', 'no-store')
  return res.status(204).send()
})

streamDeliveryReportRouter.post('/stream-delivery/report-fallback', (req, res) => {
  recordClientFallbackReported()
  res.setHeader('Cache-Control', 'no-store')
  return res.status(204).send()
})
