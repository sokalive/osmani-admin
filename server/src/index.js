import './loadEnv.js'
import cors from 'cors'
import express from 'express'
import { isStreamPlaybackPath, streamPlaybackCors } from './middleware/streamCors.js'
import {
  getCdnHealthSnapshot,
  getStaticUploadCacheMaxAgeSec,
  isCdnEnabled,
} from './lib/cdnAssets.js'
import {
  getMediaHealthSnapshot,
  initUploadStorage,
  logUploadStorageDiagnostics,
  UPLOADS_DIR,
} from './multerUpload.js'
import { wireApiCacheInvalidation } from './lib/apiCacheInvalidation.js'
import { wireApiCacheBustRelay } from './lib/apiCacheBustRelay.js'
import { wireLiveSyncRelay } from './lib/liveSyncRelay.js'
import { wireDeviceSubscriptionRelay } from './lib/deviceSubscriptionRelay.js'
import { ensureMpingoRoutingStartupSync } from './lib/mpingoRoutingSync.js'
import {
  isRenderRuntime,
  isStartupReady,
  markStartupFailed,
  markStartupReady,
  renderSuppressFatalExit,
  shouldDeferMpingoRoutingStartupSync,
  shouldWarmApiCachesOnStartup,
  wireRenderProcessGuards,
} from './lib/startupReadiness.js'
import {
  getNotificationImageStorageDiagnostics,
} from './lib/notificationImageStorage.js'
import { ensureAllApiDataFiles, restApi } from './routes/restApi.js'
import { apiRequestTimingMiddleware } from './middleware/apiRequestTiming.js'
import { streamDeliveryReportRouter } from './routes/streamDeliveryReport.js'
import { streamBunnyPullRouter } from './routes/streamBunnyPull.js'
import { streamDirectRouter } from './routes/streamDirect.js'
import { streamProxyRouter } from './routes/streamProxy.js'

const app = express()
const PORT = Number(process.env.PORT) || 4000

// Behind nginx / Render proxy — required for correct HTTPS URLs and secure cookies.
app.set('trust proxy', 1)

// --- ALLOWED ORIGINS ---
// Primary: Android app + native HTTP clients (often no `Origin` — allowed below).
// Secondary: admin panel + optional browser/WebView runtimes (explicit origins only).
const allowedOrigins = [
  'https://osmani-admin.vercel.app',
  'https://osmani-admin-mpya.onrender.com',
  'http://144.91.117.90',
  'https://144.91.117.90',
  'http://admin.osmani.tv',
  'https://admin.osmani.tv',
  'https://api.osmanitv.com',
  'https://admin.osmanitv.com',
  'https://osmanitv.com',
  'http://api.osmanitv.com',
  'http://admin.osmanitv.com',
  'http://osmanitv.com',
  'https://osmani-admin-api.onrender.com',
  'http://osmani-admin-api.onrender.com',
  'https://osmani-tv-web.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
  'http://127.0.0.1:5173',
  'http://127.0.0.1:3000',
  'http://10.0.2.2:5173',
  'http://10.0.2.2:3000',
]

function isMobileClientApiPath(req) {
  const path = String(req.path || req.url || '')
  return (
    path.startsWith('/api/payments') ||
    path.startsWith('/api/webhooks') ||
    path.startsWith('/api/subscription') ||
    path.startsWith('/api/payment-status') ||
    path.startsWith('/api/zeno-webhook')
  )
}

const corsOptions = {
  origin: (origin, callback) => {
    // No Origin, or literal "null" (React Native / WebView) — allow mobile clients.
    if (!origin || origin === 'null') return callback(null, true)

    if (allowedOrigins.includes(origin)) {
      return callback(null, true)
    }

    console.warn('❌ Blocked by CORS:', origin)
    // Do not throw — Error becomes HTTP 500 "Internal server error" and breaks APK fetch.
    return callback(null, false)
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
}

// --- MIDDLEWARE ---
// Stream HLS: permissive CORS (APK sends Origin: null / exp:// / localhost). Admin/API: strict allowlist.
const adminCors = cors(corsOptions)

function applyCors(req, res, next) {
  if (isStreamPlaybackPath(req)) return streamPlaybackCors(req, res, next)
  if (isMobileClientApiPath(req)) {
    return cors({
      origin: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      credentials: true,
    })(req, res, next)
  }
  return adminCors(req, res, next)
}

app.use(applyCors)
app.options('*', applyCors)

app.use(express.json({
  limit: '4mb',
  verify: (req, _res, buf) => {
    const path = String(req.originalUrl || req.url || req.path || '')
    if (path.includes('/payments/sonicpesa/webhook')) {
      req.rawBody = buf
    }
  },
}))
app.use('/api', apiRequestTimingMiddleware)

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
      } else if (/\.(mp4|webm|mkv|mov)$/i.test(normalized)) {
        res.setHeader('Content-Type', 'video/mp4')
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
const STARTUP_DEFERRED_RETRIES = isRenderRuntime() ? 8 : 3
const STARTUP_RETRY_BASE_MS = isRenderRuntime() ? 2000 : 1000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let deferredStartupBackgroundTimer = null

function scheduleDeferredStartupBackgroundRetry() {
  if (deferredStartupBackgroundTimer) return
  const delayMs = Math.max(15_000, Number(process.env.STARTUP_BACKGROUND_RETRY_MS) || 30_000)
  console.error(
    `[startup] Render: keeping HTTP listener alive; background deferred init retry in ${delayMs}ms`,
  )
  deferredStartupBackgroundTimer = setInterval(() => {
    void runDeferredStartup({ background: true })
  }, delayMs)
  if (typeof deferredStartupBackgroundTimer.unref === 'function') {
    deferredStartupBackgroundTimer.unref()
  }
}

async function runDeferredStartup({ background = false } = {}) {
  if (background && isStartupReady()) {
    if (deferredStartupBackgroundTimer) {
      clearInterval(deferredStartupBackgroundTimer)
      deferredStartupBackgroundTimer = null
    }
    return
  }

  const maxAttempts = background ? 1 : STARTUP_DEFERRED_RETRIES
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const uploadRetry = initUploadStorage()
      if (uploadRetry.ok) {
        logUploadStorageDiagnostics()
      } else if (!background) {
        console.warn('[uploads] deferred retry: storage still not ready:', uploadRetry.error)
      }
      await wireLiveSyncRelay()
      await wireApiCacheBustRelay()
      await wireDeviceSubscriptionRelay()
      await ensureAllApiDataFiles()
      markStartupReady()

      if (deferredStartupBackgroundTimer) {
        clearInterval(deferredStartupBackgroundTimer)
        deferredStartupBackgroundTimer = null
      }

      if (shouldWarmApiCachesOnStartup()) {
        void import('./lib/warmApiCaches.js')
          .then((m) => m.warmApiCaches())
          .catch((e) => console.warn('[warm-cache] startup:', e?.message || e))
      } else if (isRenderRuntime()) {
        console.info('[warm-cache] skipped on Render (WARM_API_CACHE_ON_STARTUP=0)')
      }

      if (shouldDeferMpingoRoutingStartupSync()) {
        ensureMpingoRoutingStartupSync()
      }

      if (process.env.AUTO_RECONCILE_UNBLOCKED_PLAYBACK !== '0') {
        const { reconcileUnblockedPlaybackAccess } = await import(
          './lib/deviceSecurityPlaybackAudit.js'
        )
        reconcileUnblockedPlaybackAccess({ emitUpdates: true })
          .then((out) => {
            console.log('[security] auto reconcile unblocked playback:', {
              scanned: out.devices_scanned,
              manual_cleared: out.manual_admin_blocked_cleared,
              intelligence: out.intelligence_unblocked,
              post_affected: out.post_reconcile?.total_affected,
            })
          })
          .catch((e) => console.error('[security] auto reconcile failed:', e))
      }

      const { startSonicpesaInboxWorker } = await import('./lib/sonicpesaWebhookWorker.js')
      const { startSonicpesaReconciliationQueueWorker } = await import(
        './lib/sonicpesaPaymentReconciliationQueue.js'
      )
      if (!isRenderRuntime()) {
        startSonicpesaInboxWorker()
        startSonicpesaReconciliationQueueWorker()
      } else {
        console.info('[sonicpesa-workers] skipped on Render — authoritative VPS workers only')
      }
      const { webhookSecretConfigured } = await import('./lib/sonicpesaWebhookHealth.js')
      const { isVpsProduction } = await import('./db/pool.js')
      if (isVpsProduction() && !webhookSecretConfigured()) {
        console.warn(
          '[sonicpesa] SONICPESA_WEBHOOK_SECRET not configured — configure secret in VPS env and SonicPesa dashboard after setting callback URL',
        )
      }

      console.log('[startup] deferred init complete')
      return
    } catch (err) {
      markStartupFailed(err)
      const label = background ? 'background' : `attempt ${attempt}/${maxAttempts}`
      console.error(`[startup] deferred init ${label} failed:`, err?.message || err)
      if (!background && attempt === STARTUP_DEFERRED_RETRIES) {
        if (isRenderRuntime()) {
          scheduleDeferredStartupBackgroundRetry()
          return
        }
        console.error('[startup] FATAL: deferred init exhausted retries')
        renderSuppressFatalExit(1, 'deferred_startup_exhausted')
      }
      if (!background) {
        await sleep(STARTUP_RETRY_BASE_MS * attempt)
      }
    }
  }
}

async function main() {
  try {
    wireRenderProcessGuards()
    wireApiCacheInvalidation()
    if (!shouldDeferMpingoRoutingStartupSync()) {
      ensureMpingoRoutingStartupSync()
    }

    const server = app.listen(PORT, () => {
      console.log(
        `🚀 API listening on port ${PORT}${isRenderRuntime() ? ' (Render early bind)' : ''}`,
      )
    })

    server.on('error', (err) => {
      if (err && err.code === 'EADDRINUSE') {
        console.error(`❌ Port ${PORT} already in use`)
      } else {
        console.error(err)
      }
      renderSuppressFatalExit(1, `http_server_error:${err?.code || 'unknown'}`)
    })

    try {
      const uploadInit = initUploadStorage()
      if (uploadInit.ok) {
        logUploadStorageDiagnostics()
      } else {
        console.warn('[uploads] storage degraded at startup:', uploadInit.error || 'unknown')
      }
    } catch (uploadErr) {
      console.error('[uploads] init threw (non-fatal):', uploadErr?.message || uploadErr)
    }

    const notifStorage = getNotificationImageStorageDiagnostics()
    console.log(
      `[notifications] image storage mode=${notifStorage.mode} renderDisk=${notifStorage.renderDiskUsed} publicOrigin=${notifStorage.publicOrigin}`,
    )

    const { scheduleDisposableUploadCleanup } = await import('./lib/uploadDisposableCleanup.js')
    scheduleDisposableUploadCleanup()

    const cdnHealth = getCdnHealthSnapshot()
    console.log(
      cdnHealth.cdnEnabled
        ? `[cdn] Bunny enabled → ${cdnHealth.cdnBaseUrl} (origin fallback ${cdnHealth.originBaseUrl})`
        : '[cdn] Bunny not configured — static images served from API origin (set BUNNY_CDN_BASE_URL)',
    )

    void runDeferredStartup()
  } catch (err) {
    console.error('❌ Failed to start server:', err)
    renderSuppressFatalExit(1, 'main_startup_catch')
  }
}

main()
