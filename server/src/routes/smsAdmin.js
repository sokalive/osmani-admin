import { Router } from 'express'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import * as smsStore from '../lib/smsStore.js'
import { listSmsRecipients, sendSmsToMany, sendSmsToPhone } from '../lib/smsService.js'
import { runSmsExpiryReminders } from '../lib/smsExpiryReminders.js'

export const smsAdminRouter = Router()

smsAdminRouter.use(requireAdminPanelAccess)

function logRowToApi(r) {
  const row = r && typeof r === 'object' ? r : {}
  return {
    id: row.id,
    recipient: String(row.recipient ?? ''),
    deviceId: String(row.device_id ?? ''),
    message: String(row.message ?? ''),
    templateKey: String(row.template_key ?? ''),
    triggerType: String(row.trigger_type ?? ''),
    status: String(row.status ?? ''),
    providerResponse: row.provider_response ?? null,
    providerMessageId: String(row.provider_message_id ?? ''),
    smsType: String(row.sms_type ?? ''),
    subscriptionId: String(row.subscription_id ?? ''),
    paymentId: String(row.payment_id ?? ''),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

smsAdminRouter.get('/log', async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 100
    const offset = Number(req.query.offset) || 0
    const { rows, total } = await smsStore.listSmsLog({ limit, offset })
    res.json({
      rows: rows.map(logRowToApi),
      total,
      limit,
      offset,
    })
  } catch (e) {
    console.error('[admin/sms] GET /log failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

smsAdminRouter.get('/templates', async (_req, res) => {
  try {
    const rows = await smsStore.listSmsTemplates()
    res.json(
      rows.map((r) => ({
        templateKey: r.template_key,
        body: r.body,
        description: r.description,
        enabled: r.enabled === true,
        updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
      })),
    )
  } catch (e) {
    console.error('[admin/sms] GET /templates failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

smsAdminRouter.put('/templates/:key', async (req, res) => {
  try {
    const key = String(req.params.key ?? '').trim()
    if (!key) return res.status(400).json({ error: 'template key required' })
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const row = await smsStore.upsertSmsTemplate({
      templateKey: key,
      body: b.body,
      description: b.description,
      enabled: b.enabled !== false,
    })
    res.json({
      templateKey: row.template_key,
      body: row.body,
      description: row.description,
      enabled: row.enabled === true,
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    })
  } catch (e) {
    console.error('[admin/sms] PUT /templates failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

smsAdminRouter.get('/recipients/counts', async (_req, res) => {
  try {
    const [all, active, expired] = await Promise.all([
      listSmsRecipients('all'),
      listSmsRecipients('active'),
      listSmsRecipients('expired'),
    ])
    res.json({
      all: all.length,
      active: active.length,
      expired: expired.length,
    })
  } catch (e) {
    console.error('[admin/sms] GET /recipients/counts failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

smsAdminRouter.post('/send', async (req, res) => {
  try {
    const b = req.body && typeof req.body === 'object' ? req.body : {}
    const message = String(b.message ?? '').trim()
    const audience = String(b.audience ?? '').toLowerCase()
    const deviceId = String(b.deviceId ?? b.device_id ?? '').trim()
    const phone = String(b.phone ?? '').trim()

    if (!message) {
      return res.status(400).json({ error: 'message is required' })
    }

    if (phone || deviceId) {
      const { resolvePaymentPhoneForDevice } = await import('../billingStore.js')
      const { resolveSmsPhoneForDevice } = await import('../lib/smsService.js')
      let targetPhone = phone
      if (!targetPhone && deviceId) {
        const { phone: fallback } = await resolvePaymentPhoneForDevice(deviceId)
        const resolved = await resolveSmsPhoneForDevice(deviceId, fallback)
        targetPhone = resolved.normalized || resolved.phone || fallback
      }
      const result = await sendSmsToPhone({
        phone: targetPhone,
        message,
        deviceId,
        triggerType: 'manual_single',
      })
      return res.json(result)
    }

    if (!['all', 'active', 'expired'].includes(audience)) {
      return res.status(400).json({ error: 'audience must be all, active, expired, or provide phone/deviceId' })
    }

    const recipients = await listSmsRecipients(audience)
    const result = await sendSmsToMany({
      recipients,
      message,
      triggerType: `broadcast_${audience}`,
    })
    res.json(result)
  } catch (e) {
    console.error('[admin/sms] POST /send failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

smsAdminRouter.post('/run-expiry-reminders', async (_req, res) => {
  try {
    const result = await runSmsExpiryReminders()
    res.json(result)
  } catch (e) {
    console.error('[admin/sms] POST /run-expiry-reminders failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})
