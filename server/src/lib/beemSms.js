/**
 * Beem Africa SMS API client (https://apisms.beem.africa/v1/send).
 * Credentials: DB beem_settings + env BEEM_API_KEY, BEEM_SECRET_KEY, BEEM_SENDER_NAME.
 */

const DEFAULT_ENDPOINT = 'https://apisms.beem.africa/v1/send'
const LOG_PREFIX = '[beem-sms]'

export function resolveBeemCredentials(row = {}) {
  const r = row && typeof row === 'object' ? row : {}
  return {
    enabled: r.enabled === true || process.env.BEEM_SMS_ENABLED === '1',
    apiKey: String(process.env.BEEM_API_KEY || r.api_key || '').trim(),
    secretKey: String(process.env.BEEM_SECRET_KEY || r.secret_key || '').trim(),
    senderName: String(process.env.BEEM_SENDER_NAME || r.sender_name || '').trim(),
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
    const ok = res.ok && body?.successful !== false
    if (!ok) {
      console.warn(LOG_PREFIX, 'send failed', res.status, body)
    }
    return {
      ok,
      status: res.status,
      error: ok ? null : String(body?.message || body?.error || `HTTP ${res.status}`),
      body,
      recipientCount: dests.length,
    }
  } catch (e) {
    console.error(LOG_PREFIX, 'request error:', e)
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
        recipients: [{ recipient_id: '0', dest_addr: '255000000000' }],
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
      return { success: false, message: 'Authentication failed — check API key and secret.' }
    }
    return {
      success: true,
      message: `Beem API reachable (HTTP ${res.status}). Credentials accepted.`,
      httpStatus: res.status,
      body,
    }
  } catch (e) {
    return { success: false, message: String(e?.message || e) }
  }
}
