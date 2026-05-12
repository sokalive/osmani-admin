import cors from 'cors'
import express from 'express'
import {
  assertUploadStorageReady,
  getMediaHealthSnapshot,
  logUploadStorageDiagnostics,
  UPLOADS_DIR,
} from './multerUpload.js'
import { ensureAllApiDataFiles, restApi } from './routes/restApi.js'
import { streamProxyRouter } from './routes/streamProxy.js'

const app = express()
const PORT = Number(process.env.PORT) || 4000

// --- ALLOWED ORIGINS ---
const allowedOrigins = [
  'https://osmani-admin.vercel.app',
  'https://osmani-admin-mpya.onrender.com',
  // Canonical production website/WebView runtime.
  'https://osmani-tv-web-vite.vercel.app',
  // Keep legacy website origin during migration/compat window.
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
    // Allow requests without Origin (Postman, curl, many mobile clients/APKs)
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
app.use(cors(corsOptions))
app.options('*', cors(corsOptions))

app.use(express.json({ limit: '4mb' }))

app.use(
  '/uploads',
  express.static(UPLOADS_DIR, {
    index: false,
    etag: true,
    lastModified: true,
    maxAge: 0,
    setHeaders(res) {
      res.setHeader('Cache-Control', 'public, max-age=0, must-revalidate')
      res.setHeader('X-Content-Type-Options', 'nosniff')
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

// --- HEALTH CHECK ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'osmani-admin-api' })
})

app.get('/api/health/media', async (req, res) => {
  const snap = await getMediaHealthSnapshot()
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
    error: snap.error,
  }
  if (!snap.ok) {
    return res.status(503).json(body)
  }
  return res.json(body)
})

// --- API ROUTES ---
app.use(streamProxyRouter)
app.use('/api', restApi)

// --- 404 HANDLER (skip /uploads — handled above) ---
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  })
})

// --- START SERVER ---
async function main() {
  try {
    assertUploadStorageReady()
    logUploadStorageDiagnostics()
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
