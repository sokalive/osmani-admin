import { normalizePhoneInternational } from './phoneNormalize.js'
import { resolveSavedDevicePhone } from './devicePhoneStore.js'
import { getPool } from '../db/pool.js'
import { beemCredentialsReady, resolveBeemCredentials, sendBeemSms, sendBeemSmsBatch } from './beemSms.js'
import * as smsStore from './smsStore.js'

const EAT = 'Africa/Dar_es_Salaam'

export function renderSmsTemplate(body, context = {}) {
  let out = String(body ?? '')
  const vars = {
    plan_name: String(context.planName ?? context.plan_name ?? ''),
    expires_at: String(context.expiresAt ?? context.expires_at ?? ''),
    remaining_days: String(context.remainingDays ?? context.remaining_days ?? ''),
    phone: String(context.phone ?? ''),
    device_id: String(context.deviceId ?? context.device_id ?? ''),
  }
  for (const [key, val] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, val)
  }
  return out.trim()
}

function phoneDigitsForBeem(phone) {
  const parsed = normalizePhoneInternational(phone)
  return parsed.valid ? parsed.normalized : ''
}

async function loadBeemCred() {
  const row = await smsStore.getBeemRow()
  return resolveBeemCredentials(row || {})
}

async function logPhoneMissing({
  deviceId,
  smsType,
  subscriptionId,
  paymentId,
  idempotencyKey,
  triggerType,
  message = '',
}) {
  const idem = String(idempotencyKey ?? '').trim()
  if (idem) {
    const ins = await smsStore.insertSmsLog({
      recipient: '',
      deviceId,
      message: message || `[${smsType}] phone missing`,
      templateKey: smsType,
      triggerType: triggerType || smsType,
      status: 'phone_missing',
      providerResponse: { reason: 'phone_missing' },
      idempotencyKey: idem,
      smsType,
      subscriptionId,
      paymentId,
    })
    if (ins.duplicate) return { ok: false, skipped: true, reason: 'duplicate', logId: ins.row?.id }
    return { ok: false, skipped: true, reason: 'phone_missing', logId: ins.row?.id }
  }
  console.log('[sms]', 'phone_missing', { deviceId: String(deviceId ?? '').slice(0, 24), smsType })
  return { ok: false, skipped: true, reason: 'phone_missing' }
}

/**
 * Resolve phone for transactional SMS: saved registry → caller fallback.
 */
export async function resolveSmsPhoneForDevice(deviceId, fallbackPhone = '') {
  const saved = await resolveSavedDevicePhone(deviceId)
  if (saved.normalized) return saved
  const digits = phoneDigitsForBeem(fallbackPhone)
  if (digits) return { phone: fallbackPhone, normalized: digits, source: 'fallback' }
  return { phone: '', normalized: '', source: null }
}

/**
 * Transactional lifecycle SMS with structured logging + idempotency.
 */
export async function sendTransactionalSms({
  phone,
  message,
  deviceId = '',
  smsType = '',
  subscriptionId = '',
  paymentId = '',
  triggerType = '',
  idempotencyKey = '',
  templateKey = '',
}) {
  const digits = phoneDigitsForBeem(phone)
  if (!digits) {
    return logPhoneMissing({
      deviceId,
      smsType,
      subscriptionId,
      paymentId,
      idempotencyKey,
      triggerType: triggerType || smsType,
      message,
    })
  }
  return sendSmsToPhone({
    phone: digits,
    message,
    deviceId,
    templateKey: templateKey || smsType,
    triggerType: triggerType || smsType,
    idempotencyKey,
    smsType,
    subscriptionId,
    paymentId,
  })
}

/**
 * Send one SMS and persist log row.
 */
export async function sendSmsToPhone({
  phone,
  message,
  deviceId = '',
  templateKey = '',
  triggerType = 'manual',
  idempotencyKey = '',
  smsType = '',
  subscriptionId = '',
  paymentId = '',
}) {
  const digits = phoneDigitsForBeem(phone)
  if (!digits) {
    return { ok: false, skipped: true, reason: 'no_phone' }
  }
  const cred = await loadBeemCred()
  if (!cred.enabled) {
    return { ok: false, skipped: true, reason: 'sms_disabled' }
  }
  if (!beemCredentialsReady(cred)) {
    return { ok: false, skipped: true, reason: 'credentials_incomplete' }
  }

  const msg = String(message ?? '').trim()
  if (!msg) return { ok: false, skipped: true, reason: 'empty_message' }

  const idem = String(idempotencyKey ?? '').trim()
  if (idem) {
    const ins = await smsStore.insertSmsLog({
      recipient: digits,
      deviceId,
      message: msg,
      templateKey,
      triggerType,
      status: 'pending',
      idempotencyKey: idem,
      smsType,
      subscriptionId,
      paymentId,
    })
    if (ins.duplicate) {
      return { ok: true, skipped: true, reason: 'duplicate', logId: ins.row?.id }
    }
  }

  const result = await sendBeemSms(cred, { phone: digits, message: msg })
  const status = result.ok ? 'sent' : 'failed'
  const providerMessageId =
    result.parsed?.requestId != null
      ? String(result.parsed.requestId)
      : result.body?.request_id != null
        ? String(result.body.request_id)
        : result.body?.data?.request_id != null
          ? String(result.body.data.request_id)
          : ''

  let logRow
  if (idem) {
    const pool = getPool()
    const { rows } = await pool.query(
      `UPDATE sms_send_log SET
         status = $2,
         provider_response = $3::jsonb,
         provider_message_id = $4
       WHERE idempotency_key = $1
       RETURNING *`,
      [idem, status, JSON.stringify(result.body ?? { error: result.error }), providerMessageId],
    )
    logRow = rows[0]
  } else {
    const ins = await smsStore.insertSmsLog({
      recipient: digits,
      deviceId,
      message: msg,
      templateKey,
      triggerType,
      status,
      providerResponse: result.body ?? { error: result.error },
      providerMessageId,
      smsType,
      subscriptionId,
      paymentId,
    })
    logRow = ins.row
  }

  return {
    ok: result.ok,
    skipped: false,
    logId: logRow?.id,
    recipient: digits,
    error: result.error,
    errorCode: result.errorCode || result.parsed?.errorCode || null,
  }
}

export async function sendTemplatedSms({
  phone,
  templateKey,
  context = {},
  deviceId = '',
  triggerType = '',
  idempotencyKey = '',
  smsType = '',
  subscriptionId = '',
  paymentId = '',
}) {
  const tpl = await smsStore.getSmsTemplate(templateKey)
  if (!tpl || tpl.enabled === false) {
    return { ok: false, skipped: true, reason: 'template_disabled' }
  }
  const message = renderSmsTemplate(tpl.body, { ...context, phone })
  return sendSmsToPhone({
    phone,
    message,
    deviceId,
    templateKey,
    triggerType: triggerType || templateKey,
    idempotencyKey,
    smsType: smsType || templateKey,
    subscriptionId,
    paymentId,
  })
}

export async function sendSmsToMany({
  recipients,
  message,
  templateKey = '',
  triggerType = 'broadcast',
}) {
  const cred = await loadBeemCred()
  if (!cred.enabled) {
    return { ok: false, skipped: true, reason: 'sms_disabled', sent: 0, failed: 0 }
  }
  if (!beemCredentialsReady(cred)) {
    return { ok: false, skipped: true, reason: 'credentials_incomplete', sent: 0, failed: 0 }
  }

  const msg = String(message ?? '').trim()
  if (!msg) return { ok: false, skipped: true, reason: 'empty_message', sent: 0, failed: 0 }

  const normalized = []
  for (const r of recipients || []) {
    const digits = phoneDigitsForBeem(r.phone)
    if (!digits) continue
    normalized.push({
      phone: digits,
      deviceId: String(r.deviceId ?? r.device_id ?? ''),
    })
  }
  const unique = [...new Map(normalized.map((x) => [x.phone, x])).values()]
  if (unique.length === 0) {
    return { ok: false, skipped: true, reason: 'no_recipients', sent: 0, failed: 0 }
  }

  const BATCH = 50
  let sent = 0
  let failed = 0
  const errors = []

  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH)
    const phones = chunk.map((c) => c.phone)
    const result = await sendBeemSmsBatch(cred, { phones, message: msg })
    const status = result.ok ? 'sent' : 'failed'
    for (const c of chunk) {
      await smsStore.insertSmsLog({
        recipient: c.phone,
        deviceId: c.deviceId,
        message: msg,
        templateKey,
        triggerType,
        status,
        providerResponse: result.body ?? { error: result.error },
        smsType: triggerType,
      })
    }
    if (result.ok) sent += chunk.length
    else {
      failed += chunk.length
      if (result.error) errors.push(result.error)
    }
  }

  return {
    ok: failed === 0,
    sent,
    failed,
    total: unique.length,
    errors: errors.slice(0, 5),
  }
}

/** Recipients for admin broadcast — saved device phone, then subscription txn phone. */
export async function listSmsRecipients(audience) {
  const pool = getPool()
  const aud = String(audience ?? 'all').toLowerCase()

  let statusFilter = ''
  if (aud === 'active') {
    statusFilter = `AND ds.status = 'active' AND ds.expires_at > now()`
  } else if (aud === 'expired') {
    statusFilter = `AND (ds.expires_at <= now() OR ds.status <> 'active')`
  }

  const { rows } = await pool.query(
    `SELECT DISTINCT ON (ds.device_id)
       ds.device_id,
       ds.expires_at,
       ds.status,
       COALESCE(
         NULLIF(trim(dpr.phone_number_normalized::text), ''),
         NULLIF(trim(t.phone::text), ''),
         ''
       ) AS phone
     FROM device_subscriptions ds
     LEFT JOIN LATERAL (
       SELECT phone_number_normalized, updated_at
       FROM device_phone_registry
       WHERE device_id = ds.device_id AND phone_number_normalized <> ''
       ORDER BY updated_at DESC
       LIMIT 1
     ) dpr ON true
     LEFT JOIN LATERAL (
       SELECT phone FROM transactions
       WHERE device_id = ds.device_id AND trim(coalesce(phone::text, '')) <> ''
       ORDER BY created_at DESC LIMIT 1
     ) t ON true
     WHERE COALESCE(NULLIF(trim(dpr.phone_number_normalized::text), ''), NULLIF(trim(t.phone::text), '')) <> ''
     ${statusFilter}
     ORDER BY ds.device_id, ds.updated_at DESC`,
  )

  return rows
    .map((r) => ({
      deviceId: String(r.device_id ?? ''),
      phone: phoneDigitsForBeem(r.phone),
      expiresAt: r.expires_at,
      status: r.status,
    }))
    .filter((r) => r.phone)
}

export { EAT }
