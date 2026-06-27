/**
 * Beem Africa SMS API client (https://apisms.beem.africa/v1/send).
 * Credentials: DB beem_settings + env BEEM_API_KEY, BEEM_SECRET_KEY, BEEM_SENDER_NAME.
 */

const DEFAULT_ENDPOINT = 'https://apisms.beem.africa/v1/send'
const LOG_PREFIX = '[beem-sms]'
const APPROVED_SENDER_DEFAULT = 'OSMANITVMAX'

/** Beem text sender IDs: max 11 alphanumeric characters, no spaces. */
export function normalizeBeemSenderName(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return ''
  const compact = s.replace(/[^A-Za-z0-9]/g, '')
  if (!compact) return ''
  return compact.slice(0, 11).toUpperCase()
}

export function validateBeemSenderName(raw) {
  const normalized = normalizeBeemSenderName(raw)
  if (!normalized) {
    return { ok: false, normalized: '', error: 'Sender name is required' }
  }
  if (normalized.length > 11) {
    return { ok: false, normalized, error: 'Sender name must be at most 11 alphanumeric characters' }
  }
  const rawTrim = String(raw ?? '').trim()
  if (/[^A-Za-z0-9]/.test(rawTrim)) {
    return {
      ok: true,
      normalized,
      warning: `Sender name "${rawTrim}" contains spaces or symbols — Beem uses "${normalized}"`,
    }
  }
  return { ok: true, normalized }
}

export function resolveBeemCredentials(row = {}) {
  const r = row && typeof row === 'object' ? row : {}
  const rawSender = String(process.env.BEEM_SENDER_NAME || r.sender_name || APPROVED_SENDER_DEFAULT).trim()
  const senderName = normalizeBeemSenderName(rawSender) || APPROVED_SENDER_DEFAULT
  return {
    enabled: r.enabled === true || process.env.BEEM_SMS_ENABLED === '1',
    apiKey: String(process.env.BEEM_API_KEY || r.api_key || '').trim(),
    secretKey: String(process.env.BEEM_SECRET_KEY || r.secret_key || '').trim(),
    senderName,
    rawSenderName: rawSender,
    endpoint: String(process.env.BEEM_SMS_ENDPOINT || DEFAULT_ENDPOINT).trim() || DEFAULT_ENDPOINT,
  }
}

export function beemCredentialsReady(cred) {
  const c = cred && typeof cred === 'object' ? cred : {}
  return Boolean(c.apiKey && c.secretKey && c.senderName)
}

function basicAuthHeader(apiKey, secretKey) {
  return `Basic ${Buffer.from(`${apiKey}:${secretKey}`, 'utf8').toString('base64')}`
}

export function parseBeemApiBody(body) {
  if (!body || typeof body !== 'object') {
    return { successful: false, message: 'Empty Beem response', errorCode: null, httpStatus: null }
  }
  if (body.successful === true || body.code === 100) {
    return {
      successful: true,
      message: String(body.message || 'Message submitted'),
      requestId: body.request_id ?? body.data?.request_id ?? null,
      valid: body.valid ?? null,
      invalid: body.invalid ?? null,
      errorCode: null,
      httpStatus: 200,
      raw: body,
    }
  }
  const nested = body.data && typeof body.data === 'object' ? body.data : null
  if (nested?.error_code || nested?.message) {
    return {
      successful: false,
      message: String(nested.message || body.message || 'Beem send failed'),
      errorCode: String(nested.error_code || body.code || ''),
      httpStatus: Number(nested.status_code || body.status_code || 0) || null,
      context: nested.context || null,
      raw: body,
    }
  }
  return {
    successful: false,
    message: String(body.message || body.error || 'Beem send failed'),
    errorCode: body.code != null ? String(body.code) : null,
    httpStatus: null,
    raw: body,
  }
}

function logBeemSendAttempt({ senderName, recipientCount, endpoint }) {
  console.log(LOG_PREFIX, 'send', {
    sender: senderName,
    recipients: recipientCount,
    endpoint,
  })
}

function logBeemSendFailure({ status, parsed, senderName }) {
  console.warn(LOG_PREFIX, 'send failed', {
    httpStatus: status,
    sender: senderName,
    errorCode: parsed.errorCode,
    message: parsed.message,
    context: parsed.context || undefined,
  })
}

/**
 * @param {object} cred
 * @param {{ phones: string[], message: string }} opts — phones as 255… digits
 */
export async function sendBeemSmsBatch(cred, { phones, message }) {
  const c = resolveBeemCredentials(cred)
  if (!beemCredentialsReady(c)) {
    return {
      ok: false,
      status: 0,
      error: 'Beem credentials incomplete (api key, secret, sender name)',
      body: null,
    }
  }
  const dests = [...new Set((phones || []).map((p) => String(p ?? '').replace(/[^0-9]/g, '')).filter(Boolean))]
  if (dests.length === 0) {
    return { ok: false, status: 0, error: 'No valid recipient phones', body: null }
  }
  const msg = String(message ?? '').trim()
  if (!msg) {
    return { ok: false, status: 0, error: 'Message is empty', body: null }
  }

  const recipients = dests.map((dest, i) => ({
    recipient_id: String(i + 1),
    dest_addr: dest,
  }))

  const payload = {
    source_addr: c.senderName,
    encoding: 0,
    schedule_time: '',
    message: msg,
    recipients,
  }

  logBeemSendAttempt({ senderName: c.senderName, recipientCount: dests.length, endpoint: c.endpoint })

  try {
    const res = await fetch(c.endpoint, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(c.apiKey, c.secretKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
    let body = null
    const text = await res.text()
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { raw: text }
    }
    const parsed = parseBeemApiBody(body)
    const ok = res.ok && parsed.successful === true
    if (!ok) {
      logBeemSendFailure({ status: res.status, parsed, senderName: c.senderName })
    } else {
      console.log(LOG_PREFIX, 'send ok', {
        sender: c.senderName,
        requestId: parsed.requestId,
        valid: parsed.valid,
        invalid: parsed.invalid,
      })
    }
    return {
      ok,
      status: res.status,
      error: ok ? null : parsed.message,
      errorCode: ok ? null : parsed.errorCode,
      body,
      parsed,
      recipientCount: dests.length,
    }
  } catch (e) {
    console.error(LOG_PREFIX, 'request error:', e?.message || e)
    return {
      ok: false,
      status: 0,
      error: String(e?.message || e),
      body: null,
    }
  }
}

export async function sendBeemSms(cred, { phone, message }) {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '')
  return sendBeemSmsBatch(cred, { phones: [digits], message })
}

export async function testBeemConnection(cred) {
  const c = resolveBeemCredentials(cred)
  if (!beemCredentialsReady(c)) {
    return {
      success: false,
      message: 'Beem credentials incomplete. Set API key, secret key, and sender name.',
    }
  }
  const senderCheck = validateBeemSenderName(c.rawSenderName || c.senderName)
  try {
    const res = await fetch(c.endpoint, {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(c.apiKey, c.secretKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        source_addr: c.senderName,
        encoding: 0,
        schedule_time: '',
        message: 'Osmani TV Beem connectivity test',
        recipients: [{ recipient_id: '0', dest_addr: '255700000001' }],
      }),
    })
    const text = await res.text()
    let body = null
    try {
      body = text ? JSON.parse(text) : null
    } catch {
      body = { raw: text }
    }
    if (res.status === 401 || res.status === 403) {
      return { success: false, message: 'Authentication failed — check API key and secret.', httpStatus: res.status, body }
    }
    const parsed = parseBeemApiBody(body)
    if (parsed.successful === true) {
      return {
        success: true,
        message: `Beem accepted sender "${c.senderName}" (HTTP ${res.status}).`,
        httpStatus: res.status,
        body,
      }
    }
    if (parsed.errorCode === 'API_INVALID_PARAMETER' || /invalid sender/i.test(parsed.message || '')) {
      return {
        success: false,
        message: `Invalid sender ID "${c.senderName}" — use approved Beem sender (e.g. ${APPROVED_SENDER_DEFAULT}). Beem: ${parsed.message}`,
        httpStatus: res.status,
        body,
        senderName: c.senderName,
      }
    }
    if (res.ok) {
      return {
        success: true,
        message: `Beem API reachable (HTTP ${res.status}). Sender "${c.senderName}" accepted.`,
        httpStatus: res.status,
        body,
        warning: senderCheck.warning,
      }
    }
    return {
      success: false,
      message: parsed.message || `Beem API error (HTTP ${res.status})`,
      httpStatus: res.status,
      body,
      senderName: c.senderName,
    }
  } catch (e) {
    return { success: false, message: String(e?.message || e) }
  }
}
