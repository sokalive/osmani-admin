import cors from 'cors'
import express from 'express'
import { ensureUploadsDir, UPLOADS_DIR } from './multerUpload.js'
import { ensureAllApiDataFiles, restApi } from './routes/restApi.js'

const app = express()
const PORT = Number(process.env.PORT) || 4000

// --- ALLOWED ORIGINS ---
const allowedOrigins = [
  'https://osmani-admin.vercel.app',
  'https://osmani-admin-mpya.onrender.com',
  'http://localhost:5173',
  'http://localhost:3000',
]

// --- MIDDLEWARE ---
app.use(
  cors({
    origin: (origin, callback) => {
      // Ruhusu request bila origin (mfano: Postman, curl)
      if (!origin) return callback(null, true)

      if (allowedOrigins.includes(origin)) {
        return callback(null, true)
      } else {
        console.warn('❌ Blocked by CORS:', origin)
        return callback(new Error('Not allowed by CORS'))
      }
    },
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    credentials: true,
  }),
)

app.use(express.json({ limit: '4mb' }))
ensureUploadsDir()
app.use('/uploads', express.static(UPLOADS_DIR))

// --- ROOT TEST ---
app.get('/', (req, res) => {
  res.type('text').send('Server yako inafanya kazi 🚀')
})

// --- HEALTH CHECK ---
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'osmani-admin-api' })
})

// --- API ROUTES ---
app.use('/api', restApi)

// --- 404 HANDLER ---
app.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  })
})

// --- START SERVER ---
async function main() {
  try {
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