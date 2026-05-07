import { Router } from 'express'
import { bannersRouter } from './banners.js'
import { channelsRouter } from './channels.js'
import { analyticsRouter } from './analytics.js'
import { ensureGlobalAppSettingsFile, globalAppSettingsRouter } from './globalAppSettings.js'
import { ensureJsonFile } from '../lib/jsonFile.js'
import { usersRouter } from './users.js'
import { ensureBannersStorage } from '../bannerStore.js'
import { ensureDataFile as ensureChannelsStorage } from '../store.js'
import { ensureBillingStorage } from '../billingStore.js'
import * as billing from '../billingStore.js'
import { handleZenoPayWebhook } from '../handlers/zenoPayWebhook.js'
import { paymentsRouter } from './payments.js'
import { plansRouter } from './plans.js'
import { transactionsRouter } from './transactions.js'
import { webhooksRouter } from './webhooks.js'
import { subscriptionRouter } from './subscription.js'
import { zenopaySettingsRouter } from './zenopaySettings.js'
import { liveSyncRouter } from './liveSync.js'
import { ensurePaymentProvidersFile, paymentProvidersRouter } from './paymentProviders.js'

const FILES = {
  users: 'users.json',
  notifications: 'notifications.json',
  transferCodes: 'transfer-codes.json',
  whatsapp: 'whatsapp.json',
  appUpdate: 'app-update.json',
  popup: 'popup.json',
  deviceControl: 'device-control.json',
  securitySuite: 'security-suite.json',
  securityLogs: 'security-logs.json',
  dashboard: 'dashboard.json',
}

export const restApi = Router()

restApi.get('/', (_req, res) => {
  res.json({
    message: 'API is working 🚀',
    endpoints: [
      '/health',
      '/users',
      '/channels',
      '/banners',
      '/settings',
      '/settings/zenopay',
      '/settings/payment-providers',
      '/payment-providers',
      '/plans',
      '/transactions',
      '/payments/create-payment',
      '/payments/zeno-webhook',
      '/zeno-webhook',
      '/payment-status/:order_id',
      '/subscription-status',
      '/subscription-stream',
      '/analytics/overview',
      '/analytics/channels',
      '/analytics/locations',
      '/analytics/trend',
      '/analytics/install',
      '/analytics/session/start',
      '/analytics/session/heartbeat',
      '/analytics/session/end',
      '/sync/stream',
      '/webhooks/zenopay',
      '/dashboard',
    ],
  })
})

restApi.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'osmani-admin-api',
    time: new Date().toISOString(),
  })
})

restApi.post('/zeno-webhook', handleZenoPayWebhook)

restApi.get('/payment-status/:order_id', async (req, res) => {
  try {
    const orderId = String(req.params.order_id ?? '').trim()
    if (!orderId) {
      return res.status(400).json({ error: 'order_id is required' })
    }
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) {
      return res.status(404).json({ error: 'Unknown order' })
    }
    const status =
      txn.status === 'completed' ? 'SUCCESS' : txn.status === 'failed' ? 'FAILED' : 'PENDING'
    res.json({ order_id: txn.order_id, status })
  } catch (e) {
    console.error('[payment-status]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

restApi.use('/users', usersRouter)
restApi.use('/channels', channelsRouter)
restApi.use('/banners', bannersRouter)
restApi.use('/settings/zenopay', zenopaySettingsRouter)
restApi.use(paymentProvidersRouter)
restApi.use('/settings', globalAppSettingsRouter)
restApi.use(subscriptionRouter)
restApi.use(liveSyncRouter)
restApi.use('/analytics', analyticsRouter)
restApi.use('/plans', plansRouter)
restApi.use('/transactions', transactionsRouter)
restApi.use('/payments', paymentsRouter)
restApi.use('/webhooks', webhooksRouter)

restApi.use((err, _req, res, _next) => {
  console.error('[restApi]', err)
  res.status(500).json({ error: String(err.message || err) })
})

restApi.use((req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl,
  })
})

export async function ensureAllApiDataFiles() {
  await ensureChannelsStorage()
  await ensureBannersStorage()
  await ensureGlobalAppSettingsFile()
  await ensurePaymentProvidersFile()
  await ensureBillingStorage()
  await ensureJsonFile(FILES.users, '[]\n')
  await ensureJsonFile(FILES.notifications, '[]\n')
  await ensureJsonFile(FILES.transferCodes, '[]\n')
  await ensureJsonFile(FILES.securityLogs, '[]\n')
  await ensureJsonFile(FILES.dashboard, '{}\n')
}
