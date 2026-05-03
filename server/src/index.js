import cors from 'cors'
import express from 'express'
import { ensureAllApiDataFiles, restApi } from './routes/restApi.js'

const app = express()
const PORT = Number(process.env.PORT) || 4000

app.use(cors({ origin: true }))
app.use(express.json({ limit: '4mb' }))

app.get('/', (_req, res) => {
  res.type('text').send('Server yako inafanya kazi 🚀')
})

app.use('/api', restApi)

async function main() {
  await ensureAllApiDataFiles()
  const server = app.listen(PORT, () => {
    console.log(`API listening on http://localhost:${PORT}`)
  })
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. Set PORT to another value.`)
    }
    process.exit(1)
  })
}

main().catch(() => {
  process.exit(1)
})
