import { Router } from 'express'
import { maskSecret } from '../billingNormalize.js'
import * as billing from '../billingStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import {
  resolveSonicpesaCredentials,
  testConnection as testSonicpesaConnection,
} from '../lib/payments/providers/sonicpesa.js'

import { defaultPublicApiOrigin } from '../lib/deployMeta.js'
import {
  canonicalSonicpesaProductionWebhookUrl,
  isLegacyRenderWebhookUrl,
  normalizeStoredSonicpesaWebhookUrl,
} from '../lib/sonicpesaWebhookConfig.js'
import { getSonicpesaWebhookHealthSnapshot, webhookSecretConfigured } from '../lib/sonicpesaWebhookHealth.js'

export const sonicpesaSettingsRouter = Router()

sonicpesaSettingsRouter.use(requireAdminPanelAccess)

function defaultWebhookUrl(_req) {
  return canonicalSonicpesaProductionWebhookUrl()
}

function normalizeEnvironment(v) {
  const s = String(v || '').trim().toLowerCase()
  if (s === 'production' || s === 'live') return 'live'
  if (s === 'test' || s === 'sandbox') return 'sandbox'
  return 'sandbox'
}

async function rowToApiResponse(row, req) {
  const r = row && typeof row === 'object' ? row : {}
  const cred = resolveSonicpesaCredentials(r)
  const checkout = await billing.getCheckoutPaymentSettings()
  const isActiveCheckoutProvider = checkout.payment_provider === 'sonicpesa'
  const apiEndpoint = String(r.api_endpoint ?? '').trim() || 'https://api.sonicpesa.com/api/v1'
  const accountId = String(r.account_id ?? '').trim()
  const webhookUrl = normalizeStoredSonicpesaWebhookUrl(r.webhook_url ?? defaultWebhookUrl(req))
  const productionWebhookUrl = canonicalSonicpesaProductionWebhookUrl()
  const webhookUrlIsLegacyRender = isLegacyRenderWebhookUrl(String(r.webhook_url ?? ''))
  const hasKey = Boolean(String(process.env.SONICPESA_API_KEY || r.api_key || '').trim())
  const apiKeyMasked = hasKey ? maskSecret(String(process.env.SONICPESA_API_KEY || r.api_key || '').trim()) : ''
  const la = r.last_test_at
  const env = normalizeEnvironment(r.environment)
  const envOverrideActive = {
    apiEndpoint: Boolean(String(process.env.SONICPESA_ENDPOINT || '').trim()),
    accountId: Boolean(String(process.env.SONICPESA_ACCOUNT_ID || '').trim()),
    apiKey: Boolean(String(process.env.SONICPESA_API_KEY || '').trim()),
    webhookUrl: Boolean(String(process.env.SONICPESA_WEBHOOK_URL || '').trim()),
  }
  const envOverrideAny = Object.values(envOverrideActive).some(Boolean)
  const lastWebhookAt = r.last_webhook_at
  const webhookHealth = await getSonicpesaWebhookHealthSnapshot().catch(() => null)
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
    accountId,
    account_id: accountId,
    webhookUrl,
    webhook_url: webhookUrl,
    productionWebhookUrl,
    production_webhook_url: productionWebhookUrl,
    webhookUrlIsLegacyRender,
    webhookSecretConfigured: webhookSecretConfigured(),
    lastProviderWebhookAt: webhookHealth?.last_provider_webhook_at ?? r.last_provider_webhook_at ?? null,
    last_provider_webhook_at: webhookHealth?.last_provider_webhook_at ?? r.last_provider_webhook_at ?? null,
    lastEngineeringProbeAt: webhookHealth?.last_engineering_probe_at ?? r.last_engineering_probe_at ?? null,
    last_engineering_probe_at: webhookHealth?.last_engineering_probe_at ?? r.last_engineering_probe_at ?? null,
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
  }
}

sonicpesaSettingsRouter.get('/', async (req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate, proxy-revalidate')
    const row = await billing.getSonicpesaRow()
    res.json(await rowToApiResponse(row, req))
  } catch (e) {
    console.error('[settings/sonicpesa] GET failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

sonicpesaSettingsRouter.put('/', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const current = (await billing.getSonicpesaRow()) || {}
    const nextKey = String(b.apiKey ?? b.api_key ?? '').trim()
    const keepKey =
      nextKey === '' ||
      nextKey === '••••••••' ||
      (nextKey.length > 0 && /^[•\u2022\s]+$/.test(nextKey))

    const apiEndpointIn = String(b.apiEndpoint ?? b.api_endpoint ?? current.api_endpoint ?? '').trim()
    if (!apiEndpointIn && !keepKey && Boolean(b.enabled)) {
      return res.status(400).json({ error: 'API endpoint is required when SonicPesa is enabled' })
    }

    const row = await billing.updateSonicpesaRowFull({
      enabled: Boolean(b.enabled ?? current.enabled ?? false),
      environment: normalizeEnvironment(b.environment ?? current.environment ?? 'sandbox'),
      api_endpoint: apiEndpointIn || 'https://api.sonicpesa.com/api/v1',
      account_id: String(b.accountId ?? b.account_id ?? current.account_id ?? ''),
      webhook_url: normalizeStoredSonicpesaWebhookUrl(
        b.webhookUrl ?? b.webhook_url ?? current.webhook_url ?? defaultWebhookUrl(req),
      ),
      keep_api_key: keepKey,
      api_key: keepKey ? '' : nextKey,
      last_test_at: b.lastTestAt ?? b.last_test_at ?? current.last_test_at,
      last_test_ok: b.lastTestOk ?? b.last_test_ok ?? current.last_test_ok,
      last_test_message: b.lastTestMessage ?? b.last_test_message ?? current.last_test_message,
    })

    const wantProvider = String(b.payment_provider ?? '').trim().toLowerCase()
    if (wantProvider === 'sonicpesa' || b.setAsActiveCheckoutProvider === true) {
      await billing.updateCheckoutPaymentProvider('sonicpesa')
    } else if (wantProvider === 'zenopay') {
      await billing.updateCheckoutPaymentProvider('zenopay')
    } else if (wantProvider === 'auraxpay') {
      await billing.updateCheckoutPaymentProvider('auraxpay')
    }

    liveSyncBus.publish('config.sonicpesa_settings_changed', {
      topics: ['config'],
      action: 'updated',
      synced_at: new Date().toISOString(),
    })
    res.setHeader('Cache-Control', 'no-store, private')
    res.json(await rowToApiResponse(row, req))
  } catch (e) {
    console.error('[settings/sonicpesa] PUT failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

sonicpesaSettingsRouter.post('/test', async (req, res) => {
  try {
    const row = (await billing.getSonicpesaRow()) || {}
    const cred = resolveSonicpesaCredentials(row)
    const result = await testSonicpesaConnection(cred)
    const now = new Date().toISOString()
    await billing.updateSonicpesaRowFull({
      enabled: Boolean(row.enabled),
      environment: normalizeEnvironment(row.environment ?? 'sandbox'),
      api_endpoint: String(row.api_endpoint ?? ''),
      account_id: String(row.account_id ?? ''),
      webhook_url: normalizeStoredSonicpesaWebhookUrl(row.webhook_url ?? defaultWebhookUrl(req)),
      keep_api_key: true,
      api_key: '',
      last_test_at: now,
      last_test_ok: result.ok,
      last_test_message: result.message,
    })
    liveSyncBus.publish('config.sonicpesa_settings_changed', {
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
    console.error('[settings/sonicpesa] POST /test failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
