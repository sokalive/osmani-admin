import cors from 'cors'
import express from 'express'
import { isStreamPlaybackPath, streamPlaybackCors } from './middleware/streamCors.js'
import {
  getCdnHealthSnapshot,
  getStaticUploadCacheMaxAgeSec,
  isCdnEnabled,
} from './lib/cdnAssets.js'
import {
  assertUploadStorageReady,
  getMediaHealthSnapshot,
  logUploadStorageDiagnostics,
  UPLOADS_DIR,
} from './multerUpload.js'
import { wireApiCacheInvalidation } from './lib/apiCacheInvalidation.js'
import { ensureMpingoRoutingStartupSync } from './lib/mpingoRoutingSync.js'
import { getStreamDeliveryHealthSnapshot } from './lib/streamDelivery.js'
import { ensureAllApiDataFiles, restApi } from './routes/restApi.js'
import { streamDeliveryReportRouter } from './routes/streamDeliveryReport.js'
import { streamBunnyPullRouter } from './routes/streamBunnyPull.js'
import { streamDirectRouter } from './routes/streamDirect.js'
import { streamProxyRouter } from './routes/streamProxy.js'

const app = express()
const PORT = Number(process.env.PORT) || 4000

// --- ALLOWED ORIGINS ---
// Primary: Android app + native HTTP clients (often no `Origin` — allowed below).
// Secondary: admin panel + optional browser/WebView runtimes (explicit origins only).
const allowedOrigins = [
  'https://osmani-admin.vercel.app',
  'https://osmani-admin-mpya.onrender.com',
  'https://osmani-tv-web-vite.vercel.app',
  'https://osmani-tv-web.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://10.0.2.2:5173',
  'http://10.0.2.2:3000',
]

const corsOptions = {
  origin: (origin, callback) => {
    // No Origin: production Android app, curl, server-to-server — default happy path.
    if (!origin) return callback(null, true)

    if (allowedOrigins.includes(origin)) {
      return callback(null, true)
    }

    console.warn('❌ Blocked by CORS:', origin)
    return callback(new Error('Not allowed by CORS'))
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
}

// --- MIDDLEWARE ---
// Stream HLS: permissive CORS (APK sends Origin: null / exp:// / localhost). Admin/API: strict allowlist.
const adminCors = cors(corsOptions)

function applyCors(req, res, next) {
  if (isStreamPlaybackPath(req)) return streamPlaybackCors(req, res, next)
  return adminCors(req, res, next)
}

app.use(applyCors)
app.options('*', applyCors)

app.use(express.json({ limit: '4mb' }))

const staticUploadMaxAgeMs = getStaticUploadCacheMaxAgeSec() * 1000

/**
 * /uploads served from disk for Bunny origin-pull (200 + bytes).
 * Do not 302 to b-cdn.net here — that caused a CDN redirect loop (API already returns Bunny URLs).
 */

app.use(
  '/uploads',
  express.static(UPLOADS_DIR, {
    index: false,
    etag: true,
    lastModified: true,
    maxAge: staticUploadMaxAgeMs,
    setHeaders(res, filePath) {
      res.setHeader('X-Content-Type-Options', 'nosniff')
      const normalized = String(filePath || '').replace(/\\/g, '/')
      if (normalized.includes('/apks/')) {
        res.setHeader('Content-Type', 'application/vnd.android.package-archive')
      }
      if (staticUploadMaxAgeMs > 0) {
        res.setHeader('Cache-Control', `public, max-age=${getStaticUploadCacheMaxAgeSec()}, immutable`)
      } else {
        res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
      }
    },
  }),
)
// Missing files: do not fall through to JSON 404
app.use('/uploads', (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).setHeader('Content-Type', 'text/plain; charset=utf-8').send('Method Not Allowed')
  }
  res
    .status(404)
    .setHeader('Content-Type', 'text/plain; charset=utf-8')
    .setHeader('Cache-Control', 'no-store')
    .send('Not found')
})

// --- ROOT TEST ---
app.get('/', (req, res) => {
  res.type('text').send('Server yako inafanya kazi 🚀')
})

// --- HEALTH CHECK (JSON body lives on restApi GET /health → /api/health) ---

app.get('/api/health/media', async (req, res) => {
  const snap = await getMediaHealthSnapshot()
  const cdn = getCdnHealthSnapshot()
  const body = {
    ok: snap.ok,
    uploadsDir: snap.uploadsDir,
    exists: snap.exists,
    writable: snap.writable,
    fileCount: snap.fileCount,
    sampleFiles: snap.sampleFiles,
    sampleReadOk: snap.sampleReadOk,
    staticRouteOk: true,
    staticPath: '/uploads',
    cdn,
    error: snap.error,
  }
  if (!snap.ok) {
    return res.status(503).json(body)
  }
  return res.json(body)
})

app.get('/api/health/stream-delivery', (_req, res) => {
  const snap = getStreamDeliveryHealthSnapshot()
  res.setHeader('Cache-Control', 'no-store')
  if (!snap.ok) {
    return res.status(503).json(snap)
  }
  return res.json(snap)
})

// --- API ROUTES ---
app.use(streamProxyRouter)
app.use(streamDirectRouter)
app.use(streamBunnyPullRouter)
app.use('/api', streamDeliveryReportRouter)
app.use('/api', restApi)

// --- 404 HANDLER (skip /uploads — handled above) ---
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  })
})

app.use((err, req, res, _next) => {
  const path = String(req.originalUrl || req.url || '')
  const isStream =
    path.includes('/stream-direct') || path.includes('/stream-proxy') || path.includes('/hls/seg')
  console.error(
    '[express-error]',
    JSON.stringify({
      path,
      method: req.method,
      message: String(err?.message || err),
      stack: String(err?.stack || '')
        .split('\n')
        .slice(0, 10)
        .join('\n'),
      stream_route: isStream,
    }),
  )
  if (res.headersSent) {
    return res.destroy(err)
  }
  if (isStream) {
    return res.status(502).json({
      error: 'stream handler failed',
      details: String(err?.message || err),
    })
  }
  return res.status(500).json({ error: 'Internal server error' })
})

// --- START SERVER ---
async function main() {
  try {
    wireApiCacheInvalidation()
    ensureMpingoRoutingStartupSync()
    assertUploadStorageReady()
    logUploadStorageDiagnostics()
    const cdnHealth = getCdnHealthSnapshot()
    console.log(
      cdnHealth.cdnEnabled
        ? `[cdn] Bunny enabled → ${cdnHealth.cdnBaseUrl} (origin fallback ${cdnHealth.originBaseUrl})`
        : '[cdn] Bunny not configured — static images served from API origin (set BUNNY_CDN_BASE_URL)',
    )
    await ensureAllApiDataFiles()

    const server = app.listen(PORT, () => {
      console.log(`🚀 API listening on port ${PORT}`)
    })

    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} already in use`)
      } else {
        console.error(err)
      }
      process.exit(1)
    })
  } catch (err) {
    console.error('❌ Failed to start server:', err)
    process.exit(1)
  }
}

main()
