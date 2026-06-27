import { Router } from 'express'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import * as smsStore from '../lib/smsStore.js'
import { listSmsRecipients, sendSmsToMany, sendSmsToPhone } from '../lib/smsService.js'
import { runSmsExpiryReminders } from '../lib/smsExpiryReminders.js'

export const smsAdminRouter = Router()

smsAdminRouter.use(requireAdminPanelAccess)

function extractProviderRequestId(row) {
  const direct = String(row.provider_message_id ?? '').trim()
  if (direct) return direct
  const pr = row.provider_response
  if (!pr || typeof pr !== 'object') return ''
  if (pr.request_id != null) return String(pr.request_id)
  if (pr.data?.request_id != null) return String(pr.data.request_id)
  if (pr.requestId != null) return String(pr.requestId)
  return ''
}

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
    providerRequestId: extractProviderRequestId(row),
    smsType: String(row.sms_type ?? ''),
    subscriptionId: String(row.subscription_id ?? ''),
    paymentId: String(row.payment_id ?? ''),
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
  }
}

function parseLogQuery(req) {
  const q = req.query && typeof req.query === 'object' ? req.query : {}
  return {
    limit: Number(q.limit) || 25,
    offset: Number(q.offset) || 0,
    search: String(q.search ?? q.q ?? '').trim(),
    status: String(q.status ?? 'all').trim().toLowerCase(),
    trigger: String(q.trigger ?? 'all').trim().toLowerCase(),
    recipient: String(q.recipient ?? '').trim(),
    dateFrom: String(q.date_from ?? q.dateFrom ?? '').trim(),
    dateTo: String(q.date_to ?? q.dateTo ?? '').trim(),
  }
}

smsAdminRouter.get('/log', async (req, res) => {
  try {
    const filters = parseLogQuery(req)
    const { rows, total, limit, offset } = await smsStore.listSmsLog(filters)
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

smsAdminRouter.get('/log/:id', async (req, res) => {
  try {
    const row = await smsStore.getSmsLogById(req.params.id)
    if (!row) return res.status(404).json({ error: 'SMS log not found' })
    res.json(logRowToApi(row))
  } catch (e) {
    console.error('[admin/sms] GET /log/:id failed:', e)
    res.status(500).json({ error: String(e.message || e) })
  }
})

smsAdminRouter.post('/log/:id/resend', async (req, res) => {
  try {
    const row = await smsStore.getSmsLogById(req.params.id)
    if (!row) return res.status(404).json({ error: 'SMS log not found' })
    if (row.status !== 'failed') {
      return res.status(400).json({ error: 'Only failed SMS can be resent' })
    }
    const message = String(row.message ?? '').trim()
    const phone = String(row.recipient ?? '').trim()
    if (!message) return res.status(400).json({ error: 'Original message is empty' })
    if (!phone) return res.status(400).json({ error: 'Original recipient is missing' })

    const result = await sendSmsToPhone({
      phone,
      message,
      deviceId: String(row.device_id ?? ''),
      templateKey: String(row.template_key ?? ''),
      triggerType: `resend_${String(row.trigger_type || 'failed').slice(0, 40)}`,
      smsType: String(row.sms_type ?? ''),
      subscriptionId: String(row.subscription_id ?? ''),
      paymentId: String(row.payment_id ?? ''),
    })

    res.json({
      ok: result.ok === true,
      logId: result.logId,
      recipient: result.recipient,
      error: result.error || null,
      skipped: result.skipped === true,
      reason: result.reason || null,
    })
  } catch (e) {
    console.error('[admin/sms] POST /log/:id/resend failed:', e)
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
