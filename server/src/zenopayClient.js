/**
 * Resolve live credentials: process.env overrides DB (production-friendly).
 */
export function resolveZenopayCredentials(row) {
  const r = row && typeof row === 'object' ? row : {}
  return {
    apiKey: String(process.env.ZENO_API_KEY || r.api_key || '').trim(),
    accountId: String(process.env.ZENO_ACCOUNT_ID || r.account_id || '').trim(),
    apiEndpoint: String(process.env.ZENO_ENDPOINT || r.api_endpoint || '').trim(),
    webhookUrl: String(process.env.ZENO_WEBHOOK_URL || r.webhook_url || '').trim(),
  }
}

function summarizeProviderHttpError(res, text) {
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  const body = String(text || '').trim()
  const looksHtml =
    ct.includes('text/html') ||
    body.startsWith('<!') ||
    body.toLowerCase().startsWith('<html')
  if (looksHtml) {
    const st = res.statusText ? ` ${res.statusText}`.trim() : ''
    return `HTTP ${res.status}${st ? ` (${st})` : ''}. The provider returned a non-JSON response (HTML or web page), not an API error body.`
  }
  const snippet = body.replace(/\s+/g, ' ').slice(0, 200)
  return snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`
}

/**
 * Config / connectivity check only — does not POST to collection or payment routes.
 * Probes the API host (HEAD, then GET on 405) so POST-only paths are never called.
 */
export async function testZenopayConnection(cred) {
  if (!cred.apiKey) {
    return { ok: false, message: 'Missing API key (configure in admin or .env).', httpStatus: 0 }
  }
  if (!cred.apiEndpoint) {
    return { ok: false, message: 'Missing API endpoint (configure in admin or .env).', httpStatus: 0 }
  }

  let probeUrl
  try {
    const parsed = new URL(String(cred.apiEndpoint).trim())
    if (!/^https?:$/i.test(parsed.protocol)) {
      return { ok: false, message: 'API endpoint must use http or https.', httpStatus: 0 }
    }
    const envProbe = String(process.env.ZENO_CONNECTIVITY_PROBE_URL || '').trim()
    probeUrl = envProbe || parsed.origin
  } catch {
    return {
      ok: false,
      message: 'Invalid API endpoint URL (use a full URL including https://).',
      httpStatus: 0,
    }
  }

  const headers = {
    Authorization: `Bearer ${cred.apiKey}`,
    ...(cred.accountId ? { 'X-Account-Id': cred.accountId } : {}),
    Accept: 'application/json, */*',
  }

  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 15_000)

  try {
    let res = await fetch(probeUrl, { method: 'HEAD', headers, signal: ac.signal })
    if (res.status === 405) {
      res = await fetch(probeUrl, { method: 'GET', headers, signal: ac.signal })
    }
    clearTimeout(t)
    const text = await res.text()

    if (res.status === 401) {
      return {
        ok: false,
        message: 'Authentication failed (HTTP 401). Check your API key.',
        httpStatus: res.status,
      }
    }
    if (res.status >= 500) {
      return { ok: false, message: summarizeProviderHttpError(res, text), httpStatus: res.status }
    }

    return {
      ok: true,
      message: `Connected (HTTP ${res.status}). API host is reachable and credentials are present.`,
      httpStatus: res.status,
    }
  } catch (e) {
    clearTimeout(t)
    const msg = e?.name === 'AbortError' ? 'Request timed out' : String(e.message || e)
    return { ok: false, message: msg, httpStatus: 0 }
  }
}

const ZENO_DEFAULT_PAYMENT_PATH = '/api/payments/mobile_money_tanzania'

/** POST target for collections — no /create suffix; honors ZENO_PAYMENT_URL or endpoint + path. */
function resolveZenopayCollectionPostUrl(cred) {
  const envFull = String(process.env.ZENO_PAYMENT_URL || '').trim()
  if (envFull) return envFull.replace(/\/+$/, '')

  const ep = String(cred?.apiEndpoint || '').trim()
  if (!ep) return ''

  const configured = String(process.env.ZENO_COLLECT_PATH || ZENO_DEFAULT_PAYMENT_PATH).trim()
  if (/^https?:\/\//i.test(configured)) {
    return configured.replace(/\/+$/, '')
  }

  const pathSuffix = (configured.startsWith('/') ? configured : `/${configured}`).replace(/\/+$/, '')

  try {
    const u = new URL(ep)
    let pathname = (u.pathname || '/').replace(/\/+$/, '') || ''
    const atMobileMoney = pathname.endsWith('/api/payments/mobile_money_tanzania')
    if (atMobileMoney) {
      return `${u.origin}${pathname}`.replace(/\/+$/, '')
    }
    const base = !pathname || pathname === '/' ? u.origin : `${u.origin}${pathname}`
    return `${base.replace(/\/+$/, '')}${pathSuffix}`
  } catch {
    return ''
  }
}

function isValidHttpsUrl(s) {
  if (!s || typeof s !== 'string') return false
  try {
    const u = new URL(s.trim())
    return u.protocol === 'https:'
  } catch {
    return false
  }
}

/** ZenoPay requires strict E.164-style +255XXXXXXXXX (digits only, then + prefix). */
export function formatPhone(phone) {
  let p = String(phone ?? '')
    .trim()
    .replace(/\D/g, '')
  if (!p) return ''
  if (p.startsWith('0')) {
    p = '255' + p.slice(1)
  }
  if (!p.startsWith('+')) {
    p = '+' + p
  }
  return p
}

/**
 * Initiate provider collection request (ZenoPay mobile money Tanzania).
 * `orderId` must match `transactions.order_id` — same value is sent as `order_id` and `reference` (ZenoPay may echo either).
 */
export async function zenopayCreateCollection(cred, { phone, amount, orderId }) {
  const url = resolveZenopayCollectionPostUrl(cred)
  if (!url) {
    return { ok: false, status: 0, body: { error: 'Invalid or missing ZenoPay API endpoint' } }
  }
  const merchantOrderId = String(orderId ?? '').trim()
  if (!merchantOrderId) {
    return { ok: false, status: 0, body: { error: 'order_id is required' } }
  }
  const buyerPhone = formatPhone(phone)
  console.log('FINAL PHONE SENT TO ZENO:', buyerPhone)
  if (!buyerPhone || !buyerPhone.startsWith('+255')) {
    return {
      ok: false,
      status: 0,
      body: { error: 'buyer_phone is required and must be in +255… format' },
    }
  }

  const accountId = String(process.env.ZENO_ACCOUNT_ID || cred.accountId || '').trim()
  if (!accountId) {
    return {
      ok: false,
      status: 0,
      body: {
        error:
          'account_id is required and cannot be empty (set ZENO_ACCOUNT_ID or ZenoPay account id in admin)',
      },
    }
  }

  const webhookUrl = String(process.env.ZENO_WEBHOOK_URL || cred.webhookUrl || '').trim()
  if (!isValidHttpsUrl(webhookUrl)) {
    return {
      ok: false,
      status: 0,
      body: {
        error:
          'webhook_url must be a valid https URL (set ZENO_WEBHOOK_URL or ZenoPay webhook URL in admin)',
      },
    }
  }

  const amountInt = Math.round(Number(amount))
  if (!Number.isFinite(amountInt) || amountInt <= 0) {
    return {
      ok: false,
      status: 0,
      body: { error: 'amount must be a positive integer' },
    }
  }

  const payload = {
    order_id: merchantOrderId,
    reference: merchantOrderId,
    buyer_name: 'Customer',
    buyer_phone: buyerPhone,
    buyer_email: 'noreply@example.com',
    amount: amountInt,
    account_id: accountId,
    webhook_url: webhookUrl,
  }
  console.log('ZENO MERCHANT ORDER ID (must match DB transactions.order_id):', merchantOrderId)

  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 30_000)
  const options = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': cred.apiKey,
    },
    body: JSON.stringify(payload),
    signal: ac.signal,
  }
  try {
    console.log('ZENO URL:', url)
    console.log('ZENO FINAL PAYLOAD:', payload)
    console.log('ZENO HEADERS:', {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ZENO_API_KEY,
    })
    const res = await fetch(url, options)
    clearTimeout(t)
    const text = await res.text()
    console.log('ZENO STATUS:', res.status)
    console.log('ZENO RAW RESPONSE:', text)
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text.slice(0, 2000) }
    }
    return { ok: res.ok, status: res.status, body: json }
  } catch (e) {
    clearTimeout(t)
    return { ok: false, status: 0, body: { error: String(e.message || e) } }
  }
}

/**
 * GET order payment status (reconcile before webhook). Docs: `/api/payments/order-status?order_id=…`
 * Override full URL with ZENO_ORDER_STATUS_URL (optional `{order_id}` placeholder).
 */
export function resolveZenopayOrderStatusUrl(cred, orderId) {
  const oid = String(orderId ?? '').trim()
  if (!oid) return ''

  const envFull = String(process.env.ZENO_ORDER_STATUS_URL || '').trim()
  if (envFull) {
    if (envFull.includes('{order_id}')) {
      return envFull.replace(/\{order_id\}/g, encodeURIComponent(oid))
    }
    const join = envFull.includes('?') ? '&' : '?'
    return `${envFull.replace(/\/+$/, '')}${join}order_id=${encodeURIComponent(oid)}`
  }

  const ep = String(cred?.apiEndpoint || '').trim()
  if (!ep) return ''
  try {
    const u = new URL(ep)
    return `${u.origin}/api/payments/order-status?order_id=${encodeURIComponent(oid)}`
  } catch {
    return ''
  }
}

export async function zenopayGetOrderStatus(cred, orderId) {
  const url = resolveZenopayOrderStatusUrl(cred, orderId)
  if (!url) {
    return { ok: false, status: 0, body: { error: 'Invalid or missing ZenoPay API endpoint for order-status' } }
  }
  const apiKey = String(process.env.ZENO_API_KEY || cred?.apiKey || '').trim()
  if (!apiKey) {
    return { ok: false, status: 0, body: { error: 'Missing API key for order-status' } }
  }

  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 18_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'x-api-key': apiKey,
      },
      signal: ac.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text.slice(0, 2000) }
    }
    return { ok: res.ok, status: res.status, body: json }
  } catch (e) {
    clearTimeout(t)
    return { ok: false, status: 0, body: { error: e?.name === 'AbortError' ? 'timeout' : String(e.message || e) } }
  }
}
