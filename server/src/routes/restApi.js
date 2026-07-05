import { Router } from 'express'
import { applySensitiveJsonGetNoStore } from '../middleware/sensitiveApiCacheControl.js'
import { bannersRouter } from './banners.js'
import { channelsRouter } from './channels.js'
import { analyticsRouter, handleLiveSessionHeartbeat } from './analytics.js'
import { analyticsAdminRouter } from './analyticsAdmin.js'
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
import { sonicpesaSettingsRouter } from './sonicpesaSettings.js'
import { auraxpaySettingsRouter } from './auraxpaySettings.js'
import { adminAuraxpayPaymentsRouter } from './adminAuraxpayPayments.js'
import { liveSyncRouter } from './liveSync.js'
import { ensurePaymentProvidersFile, paymentProvidersRouter } from './paymentProviders.js'
import { appUpdateRouter } from './appUpdate.js'
import { realtimeSettingsRouter } from './realtimeSettings.js'
import { deviceSecurityRouter } from './deviceSecurity.js'
import { deviceProfileRouter } from './deviceProfile.js'
import { deviceSecurityReportsRouter } from './deviceSecurityReports.js'
import { adminAuthRouter } from './adminAuth.js'
import { manualSubscriptionAdminRouter } from './manualSubscriptionAdmin.js'
import { offerCodesAdminRouter } from './offerCodesAdmin.js'
import { paymentOrdersAdminRouter } from './paymentOrdersAdmin.js'
import { subscriptionRequestsAdminRouter } from './subscriptionRequestsAdmin.js'
import { subscriptionRequestsPublicRouter } from './subscriptionRequestsPublic.js'
import { notificationsRouter } from './notifications.js'
import { notificationImageIngestRouter } from './notificationImageIngest.js'
import { instructionVideoIngestRouter } from './instructionVideoIngest.js'
import { beemSettingsRouter } from './beemSettings.js'
import { smsAdminRouter } from './smsAdmin.js'
import './smsScheduler.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import { deriveAppWaitingState } from '../lib/paymentAppWaitingState.js'
import { invalidateSubscriptionAccessCache } from '../lib/subscriptionAccessCache.js'
import { customerInvestigationRouter } from './customerInvestigation.js'
import { runtimePublicRouter } from './runtimePublic.js'
import { usersIntelligencePublicRouter } from './usersIntelligencePublic.js'
import { usersIntelligenceAdminRouter } from './usersIntelligenceAdmin.js'
import { appVersionMigrationAdminRouter } from './appVersionMigrationAdmin.js'
import { trialWatchSettingsRouter } from './trialWatchSettings.js'
import { trialWatchRouter } from './trialWatch.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { getPool } from '../db/pool.js'
import { getApiCacheStats } from '../lib/apiResponseCache.js'
import { getDatabaseUrlFingerprint, getServerGitCommit } from '../lib/deployMeta.js'
import { getPoolStats } from '../db/pool.js'
import { isRenderRuntime, isStartupReady, getStartupError } from '../lib/startupReadiness.js'
import { readPgConnectionStats, findSampleActiveDeviceId, findSampleActiveDeviceIds } from '../lib/pgConnectionStats.js'
import { getVerifyDbStats } from '../lib/verifyDbResilience.js'
import { readProcessCapacityStats } from '../lib/processCapacityStats.js'
import { isTrackedMobilePath, recordClientApiTelemetry } from '../lib/clientApiTelemetry.js'

const FILES = {
  users: 'users.json',
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

/** Admin + mutable JSON reads must not be served from browser HTTP cache after writes. */
restApi.use(applySensitiveJsonGetNoStore)

/** Record API host + versionCode for VPS migration audit (async, non-blocking). */
restApi.use((req, res, next) => {
  if (isTrackedMobilePath(`${req.baseUrl || ''}${req.path || ''}`)) {
    recordClientApiTelemetry(req)
  }
  next()
})

restApi.get('/', (_req, res) => {
  res.json({
    message: 'API is working 🚀',
    endpoints: [
      '/health',
      '/health/media',
      '/health/stream-delivery',
      '/stream-delivery/fallback',
      '/stream-delivery/report-fallback',
      '/stream-delivery/segment-report',
      '/users',
      '/channels',
      '/banners',
      '/settings/public',
      '/settings',
      '/settings/zenopay',
      '/settings/sonicpesa',
      '/settings/auraxpay',
      '/settings/beem',
      '/admin/sms',
      '/settings/payment-providers',
      '/payment-providers',
      '/plans',
      '/transactions',
      '/payments/create-payment',
      '/payments/checkout-providers',
      '/payments/sonicpesa/create-order',
      '/payments/sonicpesa/webhook',
      '/payments/sonicpesa/status/',
      '/admin/payments/auraxpay/create-order',
      '/payments/auraxpay/create-order',
      '/payments/auraxpay/webhook',
      '/payments/auraxpay/status/',
      '/payments/zeno-webhook',
      '/zeno-webhook',
      '/payment-status/:order_id',
      '/subscription-status',
      '/subscription/verify',
      '/subscription/acknowledge-manual-gift',
      '/subscription/redeem-offer-code',
      '/subscription-stream',
      '/admin/offer-codes/generate',
      '/admin/offer-codes/history',
      '/admin/offer-codes/block',
      '/admin/offer-codes/unblock',
      '/admin/offer-codes/bulk-block',
      '/admin/offer-codes/bulk-unblock',
      '/admin/offer-codes/bulk-delete',
      '/admin/offer-codes/:code',
      '/admin/auth/status',
      '/admin/auth/login',
      '/admin/auth/verify-otp',
      '/admin/auth/resend-otp',
      '/admin/auth/me',
      '/admin/auth/devices',
      '/admin/auth/verify-security-pin',
      '/admin/auth/admin-security/verify-pin',
      '/admin/auth/admin-security/resend-otp',
      '/admin/auth/admin-security/verify-otp',
      '/admin/auth/admin-security/destructive/start',
      '/admin/auth/admin-security/destructive/resend-otp',
      '/admin/auth/admin-security/destructive/execute',
      '/admin/auth/emergency-pin',
      '/admin/manual-subscription/grant',
      '/admin/manual-subscription/grant-custom',
      '/admin/manual-subscription/history',
      '/admin/manual-subscription/block',
      '/admin/manual-subscription/unblock',
      '/admin/manual-subscription/bulk-block',
      '/admin/manual-subscription/bulk-unblock',
      '/admin/manual-subscription/history/bulk-delete',
      '/admin/manual-subscription/history/:grantId',
      '/admin/manual-subscription/pin-status',
      '/admin/manual-subscription/setup-pin',
      '/admin/panel-diagnostics',
      '/analytics/overview',
      '/analytics/snapshot',
      '/analytics/channels',
      '/analytics/locations',
      '/analytics/trend',
      '/analytics/install',
      '/admin/analytics/reset-installs/status',
      '/admin/analytics/reset-installs/verify-password',
      '/admin/analytics/reset-installs/send-otp',
      '/admin/analytics/reset-installs/resend-otp',
      '/admin/analytics/reset-installs/execute',
      '/analytics/session/start',
      '/analytics/session/heartbeat',
      '/analytics/session/end',
      '/analytics/presence/start',
      '/analytics/presence/heartbeat',
      '/analytics/presence/stop',
      '/notifications',
      '/notifications/all',
      '/notifications/onesignal-diagnostics',
      '/notifications/runtime',
      '/runtime/app-modes',
      '/runtime/trial-watch',
      '/runtime/app-update',
      '/settings/trial-watch',
      '/trial-watch/status',
      '/trial-watch/start',
      '/trial-watch/heartbeat',
      '/trial-watch/config',
      '/update-check',
      '/verify-apk-hash',
      '/whatsapp-settings',
      '/popup-settings',
      '/server-health',
      '/transfer-codes',
      '/transfer/request',
      '/transfer/confirm',
      '/transfer/respond',
      '/transfer/status',
      '/transfer/admin-force',
      '/transfer/admin-force-phone',
      '/subscription/recover',
      '/subscription/revoke',
      '/security-logs',
      '/security-logs/:id',
      '/security-logs/bulk-delete',
      '/settings/device-control',
      '/settings/security-suite',
      '/settings/security-suite/alerts/:id',
      '/settings/security-suite/alerts/bulk-delete',
      '/transfer-codes/bulk-delete',
      '/sync/stream',
      '/webhooks/zenopay',
      '/webhooks/aurax',
      '/webhooks/auraxpay',
      '/dashboard',
    ],
    runtime: {
      primary_client: 'android_app',
      secondary_clients: ['web_player', 'admin_panel'],
    },
  })
})

restApi.get('/health', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
  const body = {
    ok: true,
    service: 'osmani-admin-api',
    time: new Date().toISOString(),
    commit: getServerGitCommit(),
    startup: {
      ready: isStartupReady(),
      error: getStartupError(),
      render: isRenderRuntime(),
      uptime_sec: Math.round(process.uptime()),
    },
  }
  if (
    String(process.env.API_CACHE_DEBUG || '').trim() === '1' ||
    String(process.env.NODE_ENV || '').toLowerCase() !== 'production'
  ) {
    body.api_cache = getApiCacheStats()
  }
  if (String(process.env.PG_POOL_STATS || '').trim() === '1' || isRenderRuntime()) {
    body.pool = getPoolStats()
    body.verify_db = getVerifyDbStats()
  }
  res.json(body)
})

restApi.get('/health/db', async (_req, res) => {
  res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
  const pg = await readPgConnectionStats()
  const body = {
    ok: pg.ok === true,
    time: new Date().toISOString(),
    commit: getServerGitCommit(),
    pg,
    verify_db: getVerifyDbStats(),
    process: readProcessCapacityStats(),
  }
  if (String(process.env.BENCHMARK_SAMPLE_DEVICE || '').trim() === '1') {
    const poolStats = getPoolStats()
    const poolPressure =
      poolStats.waitingCount > 0 ||
      (poolStats.max > 0 && poolStats.totalCount >= poolStats.max && poolStats.idleCount === 0)
    if (poolPressure) {
      body.sample_active_device_skipped = 'pool_pressure'
    } else {
      body.sample_active_device_id = await findSampleActiveDeviceId()
      const sampleLimit = Math.min(500, Math.max(1, Number(process.env.BENCHMARK_SAMPLE_DEVICE_LIMIT) || 200))
      body.sample_active_device_ids = await findSampleActiveDeviceIds(sampleLimit)
    }
  }
  res.json(body)
})

/** Admin-only: DB fingerprint + sample rows to verify read/write same Postgres as UI. */
restApi.get('/admin/panel-diagnostics', requireAdminPanelAccess, async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
    const out = {
      ok: true,
      server_commit: getServerGitCommit(),
      server_time: new Date().toISOString(),
      database: getDatabaseUrlFingerprint(),
    }
    const pool = getPool()
    if (pool) {
      const z = await pool.query(
        `SELECT id, environment, account_id,
                left(nullif(trim(api_endpoint), ''), 120) AS api_endpoint_prefix,
                updated_at
         FROM zenopay_settings WHERE id = 1`,
      )
      out.zenopay_row = z.rows[0] ?? null
      const g = await pool.query(
        `SELECT count(*)::int AS n FROM manual_subscription_grants WHERE deleted_at IS NULL`,
      )
      out.manual_grants_visible_count = g.rows[0]?.n ?? null
    }
    res.json(out)
  } catch (e) {
    console.error('[admin/panel-diagnostics]', e)
    res.status(500).json({ ok: false, error: String(e.message || e) })
  }
})

restApi.use('/admin/customer-investigation', customerInvestigationRouter)
restApi.use('/runtime', runtimePublicRouter)
restApi.use('/users-intelligence', usersIntelligencePublicRouter)
restApi.use('/admin/users-intelligence', usersIntelligenceAdminRouter)
restApi.use('/admin/app-version-migration', appVersionMigrationAdminRouter)
restApi.use(deviceSecurityReportsRouter)

restApi.post('/zeno-webhook', handleZenoPayWebhook)

restApi.get('/payment-status/:order_id', async (req, res) => {
  try {
    const orderId = String(req.params.order_id ?? '').trim()
    if (!orderId) {
      return res.status(400).json({ error: 'order_id is required' })
    }
    const rec = await reconcileOrderWithZenoPay(orderId, { forcePoll: true })
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) {
      return res.status(404).json({ error: 'Unknown order' })
    }
    const deviceId = String(txn.device_id ?? '').trim()
    let subscriptionActive = false
    if (deviceId && txn.status === 'completed') {
      const sub = await billing.getDeviceSubscriptionAccessStateFast(deviceId)
      subscriptionActive =
        sub?.active === true && String(sub.transaction_id ?? '') === String(txn.order_id)
      if (rec.activation?.activated) {
        invalidateSubscriptionAccessCache(deviceId)
      }
    }
    const waiting = deriveAppWaitingState({
      txn,
      activation: rec.activation,
      subscriptionActive,
    })
    console.log('[payment-status]', {
      orderId: orderId.length > 22 ? `${orderId.slice(0, 20)}…` : orderId,
      phase: rec.phase,
      txnStatusBefore: rec.txnStatusBefore,
      txnStatusAfter: txn.status,
      providerOk: rec.providerHttpOk,
      activated: rec.activation?.activated,
      activationReason: rec.activation?.reason ?? rec.activation?.activation_state,
      app_waiting_state: waiting.app_waiting_state,
    })
    const status =
      txn.status === 'completed' ? 'SUCCESS' : txn.status === 'failed' ? 'FAILED' : 'PENDING'
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({
      order_id: txn.order_id,
      status,
      transaction_status: txn.status,
      ...waiting,
      activation: rec.activation ?? null,
    })
  } catch (e) {
    console.error('[payment-status]', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

restApi.use('/users', usersRouter)
restApi.use('/channels', channelsRouter)
restApi.use('/banners', bannersRouter)
restApi.use('/settings/zenopay', zenopaySettingsRouter)
restApi.use('/settings/sonicpesa', sonicpesaSettingsRouter)
restApi.use('/settings/auraxpay', auraxpaySettingsRouter)
restApi.use('/settings/beem', beemSettingsRouter)
restApi.use('/admin/sms', smsAdminRouter)
restApi.use(paymentProvidersRouter)
restApi.use('/settings', globalAppSettingsRouter)
restApi.use('/settings/trial-watch', trialWatchSettingsRouter)
restApi.use('/trial-watch', trialWatchRouter)
restApi.use(appUpdateRouter)
restApi.use(realtimeSettingsRouter)
restApi.use(notificationImageIngestRouter)
restApi.use(instructionVideoIngestRouter)
restApi.use(notificationsRouter)
restApi.use(deviceSecurityRouter)
restApi.use('/device', deviceProfileRouter)
restApi.use('/admin/auth', adminAuthRouter)
restApi.use('/admin/manual-subscription', manualSubscriptionAdminRouter)
restApi.use('/admin/offer-codes', offerCodesAdminRouter)
restApi.use('/admin/payment-orders', paymentOrdersAdminRouter)
restApi.use('/admin/subscription-requests', subscriptionRequestsAdminRouter)
restApi.use('/subscription-request', subscriptionRequestsPublicRouter)
restApi.use('/admin/payments/auraxpay', adminAuraxpayPaymentsRouter)
restApi.use(subscriptionRouter)
restApi.use(liveSyncRouter)
/** Legacy APK paths (v15–v20) — same handler as POST /analytics/session/heartbeat. */
restApi.post('/live/ping', handleLiveSessionHeartbeat)
restApi.post('/session/ping', handleLiveSessionHeartbeat)
restApi.use('/analytics', analyticsRouter)
restApi.use('/admin/analytics', analyticsAdminRouter)
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
  await ensureJsonFile(FILES.transferCodes, '[]\n')
  await ensureJsonFile(FILES.securityLogs, '[]\n')
  await ensureJsonFile(FILES.dashboard, '{}\n')
}
