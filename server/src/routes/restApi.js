import { randomUUID } from 'node:crypto'
import { Router } from 'express'
import { channelsRouter } from './channels.js'
import { ensureGlobalAppSettingsFile, globalAppSettingsRouter } from './globalAppSettings.js'
import { ensureJsonFile, readJson, writeJsonAtomic } from '../lib/jsonFile.js'

const FILES = {
  banners: 'banners.json',
  plans: 'plans.json',
  users: 'users.json',
  transactions: 'transactions.json',
  notifications: 'notifications.json',
  transferCodes: 'transfer-codes.json',
  zenopay: 'zenopay.json',
  whatsapp: 'whatsapp.json',
  appUpdate: 'app-update.json',
  popup: 'popup.json',
  deviceControl: 'device-control.json',
  securitySuite: 'security-suite.json',
  securityLogs: 'security-logs.json',
  dashboard: 'dashboard.json',
}

export const restApi = Router()

/* =========================
   ✅ IMPORTANT HEALTH FIX
========================= */

// root ya /api
restApi.get('/', (_req, res) => {
  res.json({
    message: 'API is working 🚀',
    endpoints: ['/health', '/channels', '/settings', '/dashboard'],
  })
})

// health endpoint
restApi.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'osmani-admin-api',
    time: new Date().toISOString(),
  })
})

/* ========================= */

restApi.use('/channels', channelsRouter)
restApi.use('/settings', globalAppSettingsRouter)

/* =========================
   ⚠️ GLOBAL ERROR HANDLER
========================= */
restApi.use((err, _req, res, _next) => {
  console.error(err)
  res.status(500).json({ error: 'Internal server error' })
})

/* =========================
   ⚠️ NOT FOUND HANDLER
========================= */
restApi.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  })
})

/* =========================
   FILE INIT
========================= */

export async function ensureAllApiDataFiles() {
  await ensureJsonFile('channels.json', '[]\n')
  await ensureGlobalAppSettingsFile()
  await ensureJsonFile(FILES.banners, '[]\n')
  await ensureJsonFile(FILES.plans, '[]\n')
  await ensureJsonFile(FILES.users, '[]\n')
  await ensureJsonFile(FILES.transactions, '[]\n')
  await ensureJsonFile(FILES.notifications, '[]\n')
  await ensureJsonFile(FILES.transferCodes, '[]\n')
  await ensureJsonFile(FILES.securityLogs, '[]\n')
  await ensureJsonFile(FILES.dashboard, '{}\n')
}