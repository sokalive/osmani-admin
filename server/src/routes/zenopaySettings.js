import { Router } from 'express'
import { maskSecret } from '../billingNormalize.js'
import * as billing from '../billingStore.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { resolveZenopayCredentials, testZenopayConnection } from '../zenopayClient.js'

import { defaultPublicApiOrigin } from '../lib/deployMeta.js'

export const zenopaySettingsRouter = Router()

zenopaySettingsRouter.use(requireAdminPanelAccess)

function defaultWebhookUrl(req) {
  const base = (
    process.env.BASE_URL ||
    defaultPublicApiOrigin() ||
    `${req.protocol}://${req.get('host') || ''}`
  ).replace(/\/$/, '')
  return `${base}/api/zeno-webhook`
}

function normalizeEnvironment(v) {
  const s = String(v || '').trim().toLowerCase()
  if (s === 'production' || s === 'live') return 'live'
  if (s === 'test' || s === 'sandbox') return 'sandbox'
  return 'sandbox'
}

function rowToApiResponse(row, req) {
  const r = row && typeof row === 'object' ? row : {}
  const cred = resolveZenopayCredentials(r)
  /** Stored row values (what PUT wrote). Do not use `cred.*` for these — env overrides hide DB in the admin UI. */
  const apiEndpoint = String(r.api_endpoint ?? '').trim()
  const accountId = String(r.account_id ?? '').trim()
  const webhookUrl = String(r.webhook_url ?? '').trim() || defaultWebhookUrl(req)
  const hasKey = Boolean(String(process.env.ZENO_API_KEY || r.api_key || '').trim())
  const apiKeyMasked = hasKey ? maskSecret(String(process.env.ZENO_API_KEY || r.api_key || '').trim()) : ''
  const la = r.last_test_at
  const env = normalizeEnvironment(r.environment)
  const envOverrideActive = {
    apiEndpoint: Boolean(String(process.env.ZENO_ENDPOINT || '').trim()),
    accountId: Boolean(String(process.env.ZENO_ACCOUNT_ID || '').trim()),
    apiKey: Boolean(String(process.env.ZENO_API_KEY || '').trim()),
    webhookUrl: Boolean(String(process.env.ZENO_WEBHOOK_URL || '').trim()),
  }
  const envOverrideAny = Object.values(envOverrideActive).some(Boolean)
  return {
    environment: env,
    apiEndpoint,
    api_endpoint: apiEndpoint,
    /** Effective values used for live API calls (env wins over DB). */
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
    lastTestAt: la instanceof Date ? la.toISOString() : la || null,
    last_test_at: la instanceof Date ? la.toISOString() : la || null,
    lastTestOk: r.last_test_ok,
    last_test_ok: r.last_test_ok,
    lastTestMessage: r.last_test_message || '',
    last_test_message: r.last_test_message || '',
  }
}

zenopaySettingsRouter.get('/', async (req, res) => {
  try {
    const row = await billing.getZenopayRow()
    res.json(rowToApiResponse(row, req))
  } catch (e) {
    console.error('[settings/zenopay] GET failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

zenopaySettingsRouter.put('/', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const current = (await billing.getZenopayRow()) || {}
    const nextKey = String(b.apiKey ?? b.api_key ?? '').trim()
    const keepKey =
      nextKey === '' ||
      nextKey === '••••••••' ||
      (nextKey.length > 0 && /^[•\u2022\s]+$/.test(nextKey))

    const row = await billing.updateZenopayRowFull({
      environment: normalizeEnvironment(b.environment ?? current.environment ?? 'sandbox'),
      api_endpoint: String(b.apiEndpoint ?? b.api_endpoint ?? current.api_endpoint ?? ''),
      account_id: String(b.accountId ?? b.account_id ?? current.account_id ?? ''),
      webhook_url: String(
        b.webhookUrl ?? b.webhook_url ?? current.webhook_url ?? defaultWebhookUrl(req),
      ),
      keep_api_key: keepKey,
      api_key: keepKey ? '' : nextKey,
      last_test_at: b.lastTestAt ?? b.last_test_at ?? current.last_test_at,
      last_test_ok: b.lastTestOk ?? b.last_test_ok ?? current.last_test_ok,
      last_test_message: b.lastTestMessage ?? b.last_test_message ?? current.last_test_message,
    })
    liveSyncBus.publish('config.zenopay_settings_changed', {
      topics: ['config'],
      action: 'updated',
      synced_at: new Date().toISOString(),
    })
    res.json(rowToApiResponse(row, req))
  } catch (e) {
    console.error('[settings/zenopay] PUT failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

zenopaySettingsRouter.post('/test', async (req, res) => {
  try {
    const row = (await billing.getZenopayRow()) || {}
    const cred = resolveZenopayCredentials(row)
    const result = await testZenopayConnection(cred)
    const now = new Date().toISOString()
    await billing.updateZenopayRowFull({
      environment: normalizeEnvironment(row.environment ?? 'sandbox'),
      api_endpoint: String(row.api_endpoint ?? ''),
      account_id: String(row.account_id ?? ''),
      webhook_url: String(row.webhook_url ?? defaultWebhookUrl(req)),
      keep_api_key: true,
      api_key: '',
      last_test_at: now,
      last_test_ok: result.ok,
      last_test_message: result.message,
    })
    liveSyncBus.publish('config.zenopay_settings_changed', {
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
    console.error('[settings/zenopay] POST /test failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
