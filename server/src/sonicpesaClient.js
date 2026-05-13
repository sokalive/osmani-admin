/**
 * SonicPesa HTTP integration (additive; ZenoPay remains in zenopayClient.js).
 * Env vars override DB row when set (same ops pattern as ZenoPay).
 */
import { formatPhone } from './zenopayClient.js'

export function resolveSonicpesaCredentials(row) {
  const r = row && typeof row === 'object' ? row : {}
  return {
    apiKey: String(process.env.SONICPESA_API_KEY || r.api_key || '').trim(),
    accountId: String(process.env.SONICPESA_ACCOUNT_ID || r.account_id || '').trim(),
    apiEndpoint: String(process.env.SONICPESA_ENDPOINT || r.api_endpoint || '').trim(),
    webhookUrl: String(process.env.SONICPESA_WEBHOOK_URL || r.webhook_url || '').trim(),
  }
}

function resolveSonicpesaCollectPostUrl(cred) {
  const envFull = String(process.env.SONICPESA_PAYMENT_URL || '').trim()
  if (envFull) return envFull.replace(/\/+$/, '')
  const ep = String(cred?.apiEndpoint || '').trim()
  if (!ep) return ''
  const path = String(process.env.SONICPESA_COLLECT_PATH || '/api/v1/payments/initiate').trim()
  if (/^https?:\/\//i.test(path)) return path.replace(/\/+$/, '')
  try {
    const u = new URL(ep.endsWith('/') ? ep.slice(0, -1) : ep)
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${u.origin}${suffix}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

export function resolveSonicpesaOrderStatusUrl(cred, orderId) {
  const oid = String(orderId ?? '').trim()
  if (!oid) return ''
  const envFull = String(process.env.SONICPESA_ORDER_STATUS_URL || '').trim()
  if (envFull) {
    if (envFull.includes('{order_id}')) {
      return envFull.replace(/\{order_id\}/g, encodeURIComponent(oid))
    }
    return `${envFull.replace(/\/+$/, '')}/${encodeURIComponent(oid)}`
  }
  const ep = String(cred?.apiEndpoint || '').trim()
  if (!ep) return ''
  const path = String(process.env.SONICPESA_ORDER_STATUS_PATH || '/api/v1/payments/status/{order_id}')
    .replace('{order_id}', encodeURIComponent(oid))
    .trim()
  if (/^https?:\/\//i.test(path)) return path.replace(/\/+$/, '')
  try {
    const u = new URL(ep.endsWith('/') ? ep.slice(0, -1) : ep)
    const suffix = path.startsWith('/') ? path : `/${path}`
    return `${u.origin}${suffix}`.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

/**
 * Initiate SonicPesa collection. Provider-specific body; adjust via env if your gateway differs.
 */
export async function sonicpesaInitiatePayment(cred, { phone, amount, orderId }) {
  const url = resolveSonicpesaCollectPostUrl(cred)
  if (!url) {
    return { ok: false, status: 0, body: { error: 'Invalid or missing SonicPesa API endpoint' } }
  }
  const merchantOrderId = String(orderId ?? '').trim()
  if (!merchantOrderId) {
    return { ok: false, status: 0, body: { error: 'order_id is required' } }
  }
  const buyerPhone = formatPhone(phone)
  if (!buyerPhone || !buyerPhone.startsWith('+255')) {
    return {
      ok: false,
      status: 0,
      body: { error: 'phone must be valid Tanzania +255…' },
    }
  }
  const accountId = String(process.env.SONICPESA_ACCOUNT_ID || cred.accountId || '').trim()
  const webhookUrl = String(process.env.SONICPESA_WEBHOOK_URL || cred.webhookUrl || '').trim()
  const amountInt = Math.round(Number(amount))
  if (!Number.isFinite(amountInt) || amountInt <= 0) {
    return { ok: false, status: 0, body: { error: 'amount must be a positive integer' } }
  }
  const payload = {
    order_id: merchantOrderId,
    merchant_order_id: merchantOrderId,
    phone: buyerPhone,
    amount: amountInt,
    currency: 'TZS',
    account_id: accountId,
    webhook_url: webhookUrl || undefined,
  }
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 30_000)
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${String(process.env.SONICPESA_API_KEY || cred.apiKey || '').trim()}`,
  }
  if (accountId) headers['X-Account-Id'] = accountId
  if (accountId) headers['X-Merchant-Id'] = accountId
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
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
    return { ok: false, status: 0, body: { error: String(e.message || e) } }
  }
}

export async function sonicpesaGetOrderStatus(cred, orderId) {
  const url = resolveSonicpesaOrderStatusUrl(cred, orderId)
  if (!url) {
    return { ok: false, status: 0, body: { error: 'Missing SonicPesa order-status URL' } }
  }
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 20_000)
  const headers = {
    Accept: 'application/json',
    Authorization: `Bearer ${String(process.env.SONICPESA_API_KEY || cred.apiKey || '').trim()}`,
  }
  const accountId = String(process.env.SONICPESA_ACCOUNT_ID || cred.accountId || '').trim()
  if (accountId) headers['X-Account-Id'] = accountId
  try {
    const res = await fetch(url, { method: 'GET', headers, signal: ac.signal })
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
    return { ok: false, status: 0, body: { error: String(e.message || e) } }
  }
}

export async function testSonicpesaConnection(cred) {
  if (!cred.apiKey) {
    return { ok: false, message: 'Missing API key (admin or SONICPESA_API_KEY).' }
  }
  if (!cred.apiEndpoint) {
    return { ok: false, message: 'Missing API endpoint.' }
  }
  try {
    const u = new URL(String(cred.apiEndpoint).trim())
    if (!/^https?:$/i.test(u.protocol)) {
      return { ok: false, message: 'API endpoint must use http or https.' }
    }
    const probe = u.origin
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    let res = await fetch(probe, {
      method: 'HEAD',
      headers: { Authorization: `Bearer ${cred.apiKey}` },
      signal: ac.signal,
    })
    if (res.status === 405) {
      res = await fetch(probe, {
        method: 'GET',
        headers: { Authorization: `Bearer ${cred.apiKey}`, Accept: 'application/json, */*' },
        signal: ac.signal,
      })
    }
    clearTimeout(timer)
    const text = await res.text()
    return {
      ok: res.ok || res.status === 401 || res.status === 403,
      message:
        res.ok || res.status === 401 || res.status === 403
          ? `Reachable (HTTP ${res.status}). ${res.status === 401 ? 'Auth rejected — check key.' : ''}`
          : `HTTP ${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 160)}`,
      httpStatus: res.status,
    }
  } catch (e) {
    return {
      ok: false,
      message: e?.name === 'AbortError' ? 'Request timed out' : String(e.message || e),
      httpStatus: 0,
    }
  }
}
