import { Router } from 'express'
import { maskSecret } from '../billingNormalize.js'
import * as billing from '../billingStore.js'
import { resolveZenopayCredentials, testZenopayConnection } from '../zenopayClient.js'

export const zenopaySettingsRouter = Router()

function rowToApiResponse(row) {
  const r = row && typeof row === 'object' ? row : {}
  const cred = resolveZenopayCredentials(r)
  const hasKey = Boolean(cred.apiKey)
  const la = r.last_test_at
  return {
    environment: r.environment || 'test',
    apiEndpoint: cred.apiEndpoint,
    apiKey: '',
    apiKeyMasked: hasKey ? maskSecret(cred.apiKey) : '',
    hasApiKey: hasKey,
    accountId: cred.accountId,
    webhookUrl: r.webhook_url || '',
    lastTestAt: la instanceof Date ? la.toISOString() : la || null,
    lastTestOk: r.last_test_ok,
    lastTestMessage: r.last_test_message || '',
  }
}

zenopaySettingsRouter.get('/', async (_req, res) => {
  try {
    const row = await billing.getZenopayRow()
    res.json(rowToApiResponse(row))
  } catch {
    res.status(500).json({ error: 'Failed to load ZenoPay settings' })
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
      environment: String(b.environment ?? current.environment ?? 'test'),
      api_endpoint: String(b.apiEndpoint ?? b.api_endpoint ?? current.api_endpoint ?? ''),
      account_id: String(b.accountId ?? b.account_id ?? current.account_id ?? ''),
      webhook_url: String(b.webhookUrl ?? b.webhook_url ?? current.webhook_url ?? ''),
      keep_api_key: keepKey,
      api_key: keepKey ? '' : nextKey,
      last_test_at: b.lastTestAt ?? b.last_test_at ?? current.last_test_at,
      last_test_ok: b.lastTestOk ?? b.last_test_ok ?? current.last_test_ok,
      last_test_message: b.lastTestMessage ?? b.last_test_message ?? current.last_test_message,
    })
    res.json(rowToApiResponse(row))
  } catch {
    res.status(500).json({ error: 'Failed to save ZenoPay settings' })
  }
})

zenopaySettingsRouter.post('/test', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const row = (await billing.getZenopayRow()) || {}
    const cred = resolveZenopayCredentials({
      ...row,
      api_endpoint: String(b.apiEndpoint ?? b.api_endpoint ?? row.api_endpoint ?? ''),
      api_key: String(b.apiKey ?? b.api_key ?? row.api_key ?? ''),
      account_id: String(b.accountId ?? b.account_id ?? row.account_id ?? ''),
    })
    const result = await testZenopayConnection(cred)
    const now = new Date().toISOString()
    await billing.updateZenopayRowFull({
      environment: String(row.environment ?? 'test'),
      api_endpoint: cred.apiEndpoint,
      account_id: cred.accountId,
      webhook_url: String(row.webhook_url ?? ''),
      keep_api_key: true,
      api_key: '',
      last_test_at: now,
      last_test_ok: result.ok,
      last_test_message: result.message,
    })
    res.json({ ok: result.ok, message: result.message })
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) })
  }
})
