import path from 'node:path'
import { createWriteStream } from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import {
  buildInstructionVideoFilename,
  getInstructionVideoIngestToken,
  getInstructionVideoVpsIngestUrl,
  mustUseRemoteInstructionVideoStorage,
  prepareLocalInstructionVideoPath,
} from './instructionVideoFileStorage.js'
import { INSTRUCTION_VIDEO_UPLOAD_LOG } from './instructionVideoUpload.js'

function streamVideoToVpsIngest({ req, file, filename, channelId, cb }) {
  const token = getInstructionVideoIngestToken()
  const baseUrl = getInstructionVideoVpsIngestUrl(channelId)
  const targetUrl = `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}raw=1&filename=${encodeURIComponent(filename)}`

  let parsed
  try {
    parsed = new URL(targetUrl)
  } catch (e) {
    cb(e)
    return
  }

  const transport = parsed.protocol === 'https:' ? https : http
  let written = 0
  const total = Number(req.headers['content-length'] || 0)

  const proxyReq = transport.request(
    {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: `${parsed.pathname}${parsed.search}`,
      method: 'PUT',
      headers: {
        'Content-Type': file.mimetype || 'video/mp4',
        'X-Instruction-Ingest-Token': token,
        'X-Channel-Id': String(channelId),
        'X-Filename': filename,
      },
    },
    (proxyRes) => {
      const chunks = []
      proxyRes.on('data', (c) => chunks.push(c))
      proxyRes.on('end', () => {
        const bodyText = Buffer.concat(chunks).toString('utf8')
        if (proxyRes.statusCode < 200 || proxyRes.statusCode >= 300) {
          cb(new Error(`VPS ingest failed (${proxyRes.statusCode}): ${bodyText.slice(0, 200)}`))
          return
        }
        let body = {}
        try {
          body = JSON.parse(bodyText)
        } catch {
          cb(new Error('VPS ingest returned invalid JSON'))
          return
        }
        cb(null, {
          destination: 'vps-remote',
          filename: body.filename || filename,
          path: body.path || `vps:/videos/${filename}`,
          size: body.bytes || written,
          instructionVideoMetadata: body.metadata || {},
        })
      })
    },
  )

  proxyReq.on('error', (err) => cb(err))

  file.stream.on('data', (chunk) => {
    written += chunk.length
    if (total > 0 && written % (5 * 1024 * 1024) < chunk.length) {
      const pct = Math.floor((written / total) * 100)
      console.log(INSTRUCTION_VIDEO_UPLOAD_LOG, 'proxy_progress', { channelId, written, total, pct })
    }
  })

  file.stream.on('error', (err) => {
    proxyReq.destroy()
    cb(err)
  })

  file.stream.pipe(proxyReq)
}

export function createInstructionVideoMulterStorage() {
  return {
    _handleFile(req, file, cb) {
      try {
        const ext = path.extname(file.originalname || '').toLowerCase() || '.mp4'
        const channelId = String(req.params?.id ?? 'video').replace(/\D/g, '') || 'video'

        if (mustUseRemoteInstructionVideoStorage()) {
          const filename = buildInstructionVideoFilename(channelId, ext)
          console.log(INSTRUCTION_VIDEO_UPLOAD_LOG, 'remote_ingest_start', { channelId, filename })
          return streamVideoToVpsIngest({ req, file, filename, channelId, cb })
        }

        const { filename, dest } = prepareLocalInstructionVideoPath(channelId, ext)
        const total = Number(req.headers['content-length'] || 0)
        let written = 0
        let lastLoggedPct = -1
        console.log(INSTRUCTION_VIDEO_UPLOAD_LOG, 'receiving', {
          channelId,
          filename,
          contentLength: total || null,
          mimetype: file.mimetype,
        })
        const out = createWriteStream(dest)
        file.stream.on('data', (chunk) => {
          written += chunk.length
          if (total > 0) {
            const pct = Math.floor((written / total) * 100)
            if (pct >= lastLoggedPct + 10) {
              lastLoggedPct = pct - (pct % 10)
              console.log(INSTRUCTION_VIDEO_UPLOAD_LOG, 'progress', {
                channelId,
                filename,
                written,
                total,
                percent: lastLoggedPct,
              })
            }
          }
        })
        file.stream.on('error', (err) => {
          out.destroy()
          cb(err)
        })
        out.on('error', (err) => cb(err))
        out.on('finish', () => {
          console.log(INSTRUCTION_VIDEO_UPLOAD_LOG, 'saved', { channelId, filename, bytes: written })
          cb(null, { destination: path.dirname(dest), filename, path: dest, size: written })
        })
        file.stream.pipe(out)
      } catch (e) {
        cb(e)
      }
    },
    _removeFile(_req, file, cb) {
      const target = file?.path
      if (!target || String(target).startsWith('vps:')) {
        cb(null)
        return
      }
      import('node:fs').then((fs) => fs.unlink(target, (err) => cb(err)))
    },
  }
}
