import { Router } from 'express'
import { maskSecret } from '../billingNormalize.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { beemCredentialsReady, normalizeBeemSenderName, resolveBeemCredentials, testBeemConnection, validateBeemSenderName } from '../lib/beemSms.js'
import * as smsStore from '../lib/smsStore.js'

export const beemSettingsRouter = Router()

beemSettingsRouter.use(requireAdminPanelAccess)

async function rowToApiResponse(row) {
  const r = row && typeof row === 'object' ? row : {}
  const cred = resolveBeemCredentials(r)
  const hasKey = Boolean(String(process.env.BEEM_API_KEY || r.api_key || '').trim())
  const hasSecret = Boolean(String(process.env.BEEM_SECRET_KEY || r.secret_key || '').trim())
  const senderName = String(process.env.BEEM_SENDER_NAME || r.sender_name || '').trim()
  const senderValidation = validateBeemSenderName(senderName || cred.senderName)
  const la = r.last_test_at
  const envOverrideActive = {
    apiKey: Boolean(String(process.env.BEEM_API_KEY || '').trim()),
    secretKey: Boolean(String(process.env.BEEM_SECRET_KEY || '').trim()),
    senderName: Boolean(String(process.env.BEEM_SENDER_NAME || '').trim()),
  }
  return {
    enabled: r.enabled === true,
    hasApiKey: hasKey,
    hasSecretKey: hasSecret,
    apiKeyMasked: hasKey
      ? maskSecret(String(process.env.BEEM_API_KEY || r.api_key || '').trim())
      : '',
    secretKeyMasked: hasSecret
      ? maskSecret(String(process.env.BEEM_SECRET_KEY || r.secret_key || '').trim())
      : '',
    senderName: cred.senderName,
    sender_name: cred.senderName,
    rawSenderName: cred.rawSenderName || senderName,
    effectiveSenderName: cred.senderName,
    senderValidation,
    credentialsReady: beemCredentialsReady(cred),
    envOverrideAny: Object.values(envOverrideActive).some(Boolean),
    envOverrideActive,
    lastTestAt: la instanceof Date ? la.toISOString() : la || null,
    lastTestOk: r.last_test_ok,
    lastTestMessage: r.last_test_message || '',
  }
}

beemSettingsRouter.get('/', async (_req, res) => {
  try {
    res.setHeader('Cache-Control', 'no-store, private, must-revalidate')
    const row = await smsStore.getBeemRow()
    res.json(await rowToApiResponse(row))
  } catch (e) {
    console.error('[settings/beem] GET failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

beemSettingsRouter.put('/', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const patch = { enabled: b.enabled === true }
    const apiKeyIn = b.apiKey != null ? String(b.apiKey).trim() : b.api_key != null ? String(b.api_key).trim() : ''
    const secretIn =
      b.secretKey != null ? String(b.secretKey).trim() : b.secret_key != null ? String(b.secret_key).trim() : ''
    if (apiKeyIn) patch.api_key = apiKeyIn
    if (secretIn) patch.secret_key = secretIn
    const senderIn =
      b.senderName != null ? String(b.senderName).trim() : b.sender_name != null ? String(b.sender_name).trim() : ''
    if (senderIn) {
      const normalized = normalizeBeemSenderName(senderIn)
      if (!normalized) {
        return res.status(400).json({ error: 'Invalid sender name — use approved Beem sender ID (max 11 alphanumeric)' })
      }
      patch.sender_name = normalized
    }
    const row = await smsStore.updateBeemRowFull(patch)
    liveSyncBus.publish('config.beem_settings_changed', { topics: ['config'] })
    const updated = await smsStore.getBeemRow()
    res.json(await rowToApiResponse(updated || row))
  } catch (e) {
    console.error('[settings/beem] PUT failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

beemSettingsRouter.post('/test', async (_req, res) => {
  try {
    const row = (await smsStore.getBeemRow()) || {}
    const cred = resolveBeemCredentials(row)
    const result = await testBeemConnection(cred)
    await smsStore.updateBeemRowFull({
      last_test_at: new Date().toISOString(),
      last_test_ok: result.success === true,
      last_test_message: String(result.message || ''),
    })
    liveSyncBus.publish('config.beem_settings_changed', { topics: ['config'] })
    res.json({
      success: result.success === true,
      message: result.message,
    })
  } catch (e) {
    console.error('[settings/beem] POST /test failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
