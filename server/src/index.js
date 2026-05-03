import cors from 'cors'
import express from 'express'
import { ensureAllApiDataFiles, restApi } from './routes/restApi.js'

const app = express()
const PORT = Number(process.env.PORT) || 4000

app.use(cors({ origin: true }))
app.use(express.json({ limit: '4mb' }))

// ROOT TEST
app.get('/', (_req, res) => {
  res.type('text').send('Server yako inafanya kazi 🚀')
})

// 🔥 HEALTH CHECK (MUHIMU SANA)
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok' })
})

// API ROUTES
app.use('/api', restApi)

// 404 HANDLER (OPTIONAL BUT GOOD)
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' })
})

async function main() {
  await ensureAllApiDataFiles()

  const server = app.listen(PORT, () => {
    console.log(`API listening on port ${PORT}`)
  })

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use.`)
    }
    process.exit(1)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})