import { Router } from 'express'
import { maskSecret } from '../billingNormalize.js'
import * as billing from '../billingStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import {
  detectAuraxpayApiStyle,
  resolveAuraxpayCollectPostUrl,
  resolveAuraxpayCredentials,
  testConnection as testAuraxpayConnection,
} from '../lib/payments/providers/auraxpay.js'
import { defaultPublicApiOrigin } from '../lib/deployMeta.js'

export const auraxpaySettingsRouter = Router()

auraxpaySettingsRouter.use(requireAdminPanelAccess)

function defaultWebhookUrl(req) {
  const base = (
    process.env.BASE_URL ||
    defaultPublicApiOrigin() ||
    `${req.protocol}://${req.get('host') || ''}`
  ).replace(/\/$/, '')
  return `${base}/api/payments/auraxpay/webhook`
}

function normalizeEnvironment(v) {
  const s = String(v || '').trim().toLowerCase()
  if (s === 'production' || s === 'live') return 'live'
  if (s === 'test' || s === 'sandbox') return 'sandbox'
  return 'sandbox'
}

async function rowToApiResponse(row, req) {
  const r = row && typeof row === 'object' ? row : {}
  const cred = resolveAuraxpayCredentials(r)
  const checkout = await billing.getCheckoutPaymentSettings()
  const isActiveCheckoutProvider = checkout.payment_provider === 'auraxpay'
  const apiEndpoint = String(r.api_endpoint ?? '').trim()
  const accountId = String(r.account_id ?? '').trim()
  const webhookUrl = String(r.webhook_url ?? '').trim() || defaultWebhookUrl(req)
  const hasKey = Boolean(String(process.env.AURAXPAY_API_KEY || r.api_key || '').trim())
  const hasSigningSecret = Boolean(cred.signingSecret)
  const apiKeyMasked = hasKey
    ? maskSecret(String(process.env.AURAXPAY_API_KEY || r.api_key || '').trim())
    : ''
  const signingSecretMasked = hasSigningSecret ? maskSecret(cred.signingSecret) : ''
  const la = r.last_test_at
  const env = normalizeEnvironment(r.environment)
  const envOverrideActive = {
    apiEndpoint: Boolean(
      String(process.env.AURAXPAY_ENDPOINT || process.env.AURAXPAY_BASE_URL || '').trim(),
    ),
    accountId: Boolean(String(process.env.AURAXPAY_ACCOUNT_ID || '').trim()),
    apiKey: Boolean(String(process.env.AURAXPAY_API_KEY || '').trim()),
    signingSecret: Boolean(
      String(
        process.env.AURAXPAY_SIGNING_SECRET ||
          process.env.AURAXPAY_SECRET_KEY ||
          process.env.AURAXPAY_WEBHOOK_SECRET ||
          '',
      ).trim(),
    ),
    webhookUrl: Boolean(String(process.env.AURAXPAY_WEBHOOK_URL || '').trim()),
  }
  const envOverrideAny = Object.values(envOverrideActive).some(Boolean)
  const lastWebhookAt = r.last_webhook_at
  return {
    enabled: r.enabled === true,
    isActiveCheckoutProvider,
    payment_provider: checkout.payment_provider,
    environment: env,
    apiEndpoint,
    api_endpoint: apiEndpoint,
    effectiveApiEndpoint: cred.apiEndpoint,
    effectiveAccountId: cred.accountId,
    envOverrideActive,
    envOverrideAny,
    hasApiKey: hasKey,
    apiKeyMasked: apiKeyMasked || '******',
    hasSigningSecret,
    signingSecretMasked: signingSecretMasked || (hasSigningSecret ? '******' : ''),
    accountIdOptional: true,
    accountIdIsMerchantPhone: true,
    merchantPhone: accountId,
    merchant_phone: accountId,
    accountId,
    account_id: accountId,
    webhookUrl,
    webhook_url: webhookUrl,
    lastTestAt: la instanceof Date ? la.toISOString() : la || null,
    last_test_at: la instanceof Date ? la.toISOString() : la || null,
    lastTestOk: r.last_test_ok,
    last_test_ok: r.last_test_ok,
    lastTestMessage: r.last_test_message || '',
    last_test_message: r.last_test_message || '',
    lastWebhookAt: lastWebhookAt instanceof Date ? lastWebhookAt.toISOString() : lastWebhookAt || null,
    last_webhook_at: lastWebhookAt instanceof Date ? lastWebhookAt.toISOString() : lastWebhookAt || null,
    lastWebhookEvent: String(r.last_webhook_event ?? ''),
    last_webhook_event: String(r.last_webhook_event ?? ''),
    lastWebhookOrderId: String(r.last_webhook_order_id ?? ''),
    last_webhook_order_id: String(r.last_webhook_order_id ?? ''),
    detectedApiStyle: detectAuraxpayApiStyle(cred),
    collectPostUrl: resolveAuraxpayCollectPostUrl(cred),
    lastCreateOrderAt:
      r.last_create_order_at instanceof Date
        ? r.last_create_order_at.toISOString()
        : r.last_create_order_at || null,
    lastCreateOrderUrl: String(r.last_create_order_url ?? ''),
    lastCreateOrderApiStyle: String(r.last_create_order_api_style ?? ''),
    lastCreateOrderHttpStatus: r.last_create_order_http_status ?? null,
    lastCreateOrderResponse: r.last_create_order_response ?? null,
  }
}

auraxpaySettingsRouter.get('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
    const row = await billing.getAuraxpayRow()
    res.json(await rowToApiResponse(row, req))
  } catch (e) {
    console.error('[settings/auraxpay] GET failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

auraxpaySettingsRouter.put('/', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const current = (await billing.getAuraxpayRow()) || {}
    const nextKey = String(b.apiKey ?? b.api_key ?? '').trim()
    const keepKey =
      nextKey === '' ||
      nextKey === '••••••••' ||
      (nextKey.length > 0 && /^[•\u2022\s]+$/.test(nextKey))
    const nextSecret = String(
      b.webhookSecret ?? b.webhook_secret ?? b.signingSecret ?? b.signing_secret ?? '',
    ).trim()
    const keepSecret =
      nextSecret === '' ||
      nextSecret === '••••••••' ||
      (nextSecret.length > 0 && /^[•\u2022\s]+$/.test(nextSecret))

    const apiEndpointIn = String(b.apiEndpoint ?? b.api_endpoint ?? current.api_endpoint ?? '').trim()
    if (!apiEndpointIn && !keepKey && Boolean(b.enabled)) {
      return res.status(400).json({ error: 'API endpoint is required when Aurax Pay is enabled' })
    }

    const phoneRaw = String(
      b.merchantPhone ?? b.merchant_phone ?? b.accountId ?? b.account_id ?? current.account_id ?? '',
    ).trim()
    const accountIdNormalized = phoneRaw ? billing.normalizePhoneDigits(phoneRaw) || phoneRaw : ''

    const row = await billing.updateAuraxpayRowFull({
      enabled: Boolean(b.enabled ?? current.enabled ?? false),
      environment: normalizeEnvironment(b.environment ?? current.environment ?? 'sandbox'),
      api_endpoint: apiEndpointIn,
      account_id: accountIdNormalized,
      webhook_url: String(
        b.webhookUrl ?? b.webhook_url ?? current.webhook_url ?? defaultWebhookUrl(req),
      ),
      keep_api_key: keepKey,
      api_key: keepKey ? '' : nextKey,
      keep_webhook_secret: keepSecret,
      webhook_secret: keepSecret ? '' : nextSecret,
      last_test_at: b.lastTestAt ?? b.last_test_at ?? current.last_test_at,
      last_test_ok: b.lastTestOk ?? b.last_test_ok ?? current.last_test_ok,
      last_test_message: b.lastTestMessage ?? b.last_test_message ?? current.last_test_message,
    })

    const wantProvider = String(b.payment_provider ?? '').trim().toLowerCase()
    if (wantProvider === 'auraxpay' || b.setAsActiveCheckoutProvider === true) {
      await billing.updateCheckoutPaymentProvider('auraxpay')
    } else if (wantProvider === 'zenopay') {
      await billing.updateCheckoutPaymentProvider('zenopay')
    } else if (wantProvider === 'sonicpesa') {
      await billing.updateCheckoutPaymentProvider('sonicpesa')
    }

    liveSyncBus.publish('config.auraxpay_settings_changed', {
      topics: ['config'],
      action: 'updated',
      synced_at: new Date().toISOString(),
    })
    res.setHeader('Cache-Control', 'no-store, private')
    res.json(await rowToApiResponse(row, req))
  } catch (e) {
    console.error('[settings/auraxpay] PUT failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

auraxpaySettingsRouter.post('/set-active-provider', async (req, res) => {
  try {
    const row = (await billing.getAuraxpayRow()) || {}
    const cred = resolveAuraxpayCredentials(row)
    if (!row.enabled) {
      return res.status(400).json({ error: 'Enable Aurax Pay before setting it as the active checkout provider' })
    }
    if (!cred.apiKey || !cred.apiEndpoint) {
      return res.status(400).json({ error: 'Aurax Pay API endpoint and key are required' })
    }
    const checkout = await billing.updateCheckoutPaymentProvider('auraxpay')
    liveSyncBus.publish('config.auraxpay_settings_changed', {
      topics: ['config'],
      action: 'set_active_provider',
      payment_provider: checkout.payment_provider,
      synced_at: new Date().toISOString(),
    })
    res.setHeader('Cache-Control', 'no-store, private')
    res.json({
      ok: true,
      payment_provider: checkout.payment_provider,
      isActiveCheckoutProvider: true,
      updated_at: checkout.updated_at,
    })
  } catch (e) {
    console.error('[settings/auraxpay] POST /set-active-provider failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

auraxpaySettingsRouter.post('/test', async (req, res) => {
  try {
    const row = (await billing.getAuraxpayRow()) || {}
    const cred = resolveAuraxpayCredentials(row)
    const result = await testAuraxpayConnection(cred)
    const now = new Date().toISOString()
    await billing.updateAuraxpayRowFull({
      enabled: Boolean(row.enabled),
      environment: normalizeEnvironment(row.environment ?? 'sandbox'),
      api_endpoint: String(row.api_endpoint ?? ''),
      account_id: String(row.account_id ?? ''),
      webhook_url: String(row.webhook_url ?? defaultWebhookUrl(req)),
      keep_api_key: true,
      api_key: '',
      keep_webhook_secret: true,
      webhook_secret: '',
      last_test_at: now,
      last_test_ok: result.ok,
      last_test_message: result.message,
    })
    liveSyncBus.publish('config.auraxpay_settings_changed', {
      topics: ['config'],
      action: 'tested',
      success: result.ok,
      synced_at: new Date().toISOString(),
    })
    res.json({
      success: result.ok,
      message: result.message,
      httpStatus: Number(result.httpStatus || 0),
    })
  } catch (e) {
    console.error('[settings/auraxpay] POST /test failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
