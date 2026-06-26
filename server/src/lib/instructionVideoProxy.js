import http from 'node:http'
import https from 'node:https'
import {
  getInstructionVideoIngestToken,
  getInstructionVideoVpsIngestUrl,
  mustUseRemoteInstructionVideoStorage,
} from './instructionVideoFileStorage.js'
import { INSTRUCTION_VIDEO_UPLOAD_LOG } from './instructionVideoUpload.js'

/**
 * Stream multipart upload from Render to VPS ingest — zero bytes on Render disk.
 */
export function proxyInstructionVideoUploadToVps(req, res) {
  const channelId = String(req.params?.id ?? '').trim()
  const targetUrl = getInstructionVideoVpsIngestUrl(channelId)
  const token = getInstructionVideoIngestToken()
  if (!token) {
    res.status(503).json({ success: false, error: 'Instruction video VPS ingest token not configured' })
    return
  }

  let parsed
  try {
    parsed = new URL(targetUrl)
  } catch (e) {
    res.status(500).json({ success: false, error: String(e.message || e) })
    return
  }

  const transport = parsed.protocol === 'https:' ? https : http
  const headers = {
    ...req.headers,
    host: parsed.host,
    'x-instruction-ingest-token': token,
    'x-channel-id': channelId,
  }
  delete headers['content-length']

  console.log(INSTRUCTION_VIDEO_UPLOAD_LOG, 'proxy_to_vps', { channelId, target: targetUrl })

  const proxyReq = transport.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'POST',
      headers,
    },
    (proxyRes) => {
      const chunks = []
      proxyRes.on('data', (c) => chunks.push(c))
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        res.status(proxyRes.statusCode || 502)
        const ct = proxyRes.headers['content-type']
        if (ct) res.setHeader('Content-Type', ct)
        res.send(body)
      })
    },
  )

  proxyReq.on('error', (err) => {
    console.error(INSTRUCTION_VIDEO_UPLOAD_LOG, 'proxy_error', err?.message || err)
    if (!res.headersSent) {
      res.status(502).json({ success: false, error: `VPS ingest proxy failed: ${err?.message || err}` })
    }
  })

  req.pipe(proxyReq)
}

export function maybeProxyInstructionVideoToVps(req, res, next) {
  if (!mustUseRemoteInstructionVideoStorage()) return next()
  return proxyInstructionVideoUploadToVps(req, res)
}
