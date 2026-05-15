/**
 * SonicPesa payment provider (isolated — ZenoPay lives in zenopayClient.js).
 * @see https://docs.sonicpesa.com/pages/payments.html
 */
import crypto from 'node:crypto'
import { formatPhone } from '../../../zenopayClient.js'
import {
  webhookExplicitFailure,
  webhookSuccess,
} from '../../../handlers/zenoPayWebhook.js'

const DEFAULT_API_BASE = 'https://api.sonicpesa.com/api/v1'
const LOG_PREFIX = '[sonicpesa]'

export function resolveSonicpesaCredentials(row) {
  const r = row && typeof row === 'object' ? row : {}
  const apiEndpoint = String(process.env.SONICPESA_ENDPOINT || r.api_endpoint || DEFAULT_API_BASE).trim()
  return {
    apiKey: String(process.env.SONICPESA_API_KEY || r.api_key || '').trim(),
    accountId: String(process.env.SONICPESA_ACCOUNT_ID || r.account_id || '').trim(),
    apiEndpoint: apiEndpoint.replace(/\/+$/, ''),
    webhookUrl: String(process.env.SONICPESA_WEBHOOK_URL || r.webhook_url || '').trim(),
    environment: String(r.environment || 'sandbox').trim(),
  }
}

function apiBase(cred) {
  const ep = String(cred?.apiEndpoint || DEFAULT_API_BASE).trim().replace(/\/+$/, '')
  return ep || DEFAULT_API_BASE
}

function collectPath() {
  const p = String(process.env.SONICPESA_COLLECT_PATH || '/payment/create_order').trim()
  return p.startsWith('/') ? p : `/${p}`
}

function verifyPath(orderId) {
  const oid = encodeURIComponent(String(orderId ?? '').trim())
  const tpl = String(process.env.SONICPESA_VERIFY_PATH || '/payment/status/{order_id}').trim()
  return tpl.replace(/\{order_id\}/g, oid).replace(/^([^/])/, '/$1')
}

function authHeaders(cred) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-API-KEY': String(process.env.SONICPESA_API_KEY || cred.apiKey || '').trim(),
  }
  const accountId = String(process.env.SONICPESA_ACCOUNT_ID || cred.accountId || '').trim()
  if (accountId) {
    headers['X-Account-Id'] = accountId
    headers['X-Merchant-Id'] = accountId
  }
  return headers
}

async function httpJson(url, { method = 'GET', headers = {}, body } = {}) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: ac.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text.slice(0, 4000) }
    }
    return { ok: res.ok, status: res.status, body: json }
  } catch (e) {
    clearTimeout(t)
    return { ok: false, status: 0, body: { error: String(e.message || e) } }
  }
}

/**
 * Normalize SonicPesa HTTP JSON into a stable internal shape.
 */
export function normalizeResponse(raw, httpStatus = 0) {
  const body = raw && typeof raw === 'object' ? raw : {}
  const data = body.data && typeof body.data === 'object' ? body.data : body
  const providerOrderId = String(
    data.order_id ?? data.orderId ?? body.order_id ?? body.orderId ?? '',
  ).trim()
  const paymentStatus = String(
    data.payment_status ?? data.status ?? body.status ?? '',
  ).trim()
  const transId = String(
    data.transid ?? data.transaction_id ?? data.trans_id ?? body.transid ?? '',
  ).trim()
  const message = String(body.message ?? data.message ?? '').trim()
  const succeeded =
    String(body.status ?? '').toLowerCase() === 'success' ||
    ['SUCCESS', 'COMPLETED', 'PAID'].includes(paymentStatus.toUpperCase()) ||
    webhookSuccess(body) ||
    webhookSuccess(data)
  const failed =
    ['FAILED', 'DECLINED', 'CANCELLED', 'REJECTED'].includes(paymentStatus.toUpperCase()) ||
    webhookExplicitFailure(body) ||
    webhookExplicitFailure(data)
  return {
    httpStatus: Number(httpStatus) || 0,
    providerOrderId: providerOrderId || null,
    paymentStatus: paymentStatus || null,
    transId: transId || null,
    message: message || null,
    succeeded,
    failed,
    raw: body,
  }
}

/**
 * POST /payment/create_order — Push USSD collection.
 */
export async function createOrder(cred, { phone, amount, orderId, currency = 'TZS' }) {
  const url = `${apiBase(cred)}${collectPath()}`
  const buyerPhone = formatPhone(phone).replace(/^\+/, '')
  if (!buyerPhone || !buyerPhone.startsWith('255')) {
    return {
      ok: false,
      status: 0,
      body: { error: 'buyer_phone must be valid Tanzania +255…' },
      normalized: null,
    }
  }
  const amountInt = Math.round(Number(amount))
  if (!Number.isFinite(amountInt) || amountInt <= 0) {
    return {
      ok: false,
      status: 0,
      body: { error: 'amount must be a positive integer' },
      normalized: null,
    }
  }
  const payload = {
    buyer_phone: buyerPhone,
    amount: amountInt,
    currency: String(currency || 'TZS').trim() || 'TZS',
  }
  const merchantRef = String(orderId ?? '').trim()
  if (merchantRef) {
    payload.merchant_order_id = merchantRef
    payload.reference = merchantRef
  }
  console.log(LOG_PREFIX, 'createOrder', { url, merchantRef, amount: amountInt })
  const res = await httpJson(url, { method: 'POST', headers: authHeaders(cred), body: payload })
  const normalized = normalizeResponse(res.body, res.status)
  return { ...res, normalized, merchantOrderId: merchantRef }
}

/**
 * Poll / verify payment status by merchant or provider order id.
 */
export async function verifyPayment(cred, orderId) {
  const oid = String(orderId ?? '').trim()
  if (!oid) {
    return { ok: false, status: 0, body: { error: 'order_id is required' }, normalized: null }
  }
  const path = verifyPath(oid)
  const url = /^https?:\/\//i.test(path)
    ? path.replace(/\/+$/, '')
    : `${apiBase(cred)}${path.startsWith('/') ? path : `/${path}`}`
  console.log(LOG_PREFIX, 'verifyPayment', { url })
  const res = await httpJson(url, { method: 'GET', headers: authHeaders(cred) })
  const normalized = normalizeResponse(res.body, res.status)
  return { ...res, normalized }
}

export function sonicPaymentSucceeded(body) {
  const n = normalizeResponse(body)
  return n.succeeded
}

export function sonicExplicitFailure(body) {
  const n = normalizeResponse(body)
  return n.failed
}

export function verifyWebhookSignature(req, body) {
  const secret = String(process.env.SONICPESA_WEBHOOK_SECRET || '').trim()
  if (!secret) return true
  const rawSig = String(req.headers['x-sonicpesa-signature'] ?? req.headers['x-webhook-signature'] ?? '').trim()
  if (!rawSig) return false
  const sig = rawSig.replace(/^sha256=/i, '').trim()
  const raw = JSON.stringify(body ?? {})
  const expectedHex = crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  try {
    const a = Buffer.from(expectedHex, 'hex')
    const b = Buffer.from(sig, 'hex')
    if (a.length === b.length && a.length > 0) return crypto.timingSafeEqual(a, b)
  } catch {
    // fall through
  }
  const a2 = Buffer.from(expectedHex, 'utf8')
  const b2 = Buffer.from(sig, 'utf8')
  return a2.length === b2.length && crypto.timingSafeEqual(a2, b2)
}

function webhookOrderIdFromBody(body) {
  const o = body && typeof body === 'object' ? body : {}
  return String(o.order_id ?? o.orderId ?? o.merchant_order_id ?? o.reference ?? '').trim()
}

/**
 * Process SonicPesa webhook (injected billing + bus deps to keep provider free of route wiring).
 */
export async function handleWebhook(req, res, deps) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const { billing, liveSyncBus, deviceSubscriptionBus, recordWebhookMeta } = deps
  try {
    if (!verifyWebhookSignature(req, body)) {
      console.warn(LOG_PREFIX, 'webhook invalid signature')
      return res.status(401).type('text/plain').send('invalid signature')
    }
    if (typeof recordWebhookMeta === 'function') {
      await recordWebhookMeta(body)
    }
    const orderId = webhookOrderIdFromBody(body)
    if (!orderId) {
      return res.sendStatus(200)
    }
    const txn = await billing.getTransactionByOrderId(orderId)
    if (!txn) {
      console.warn(LOG_PREFIX, 'webhook unknown order', orderId)
      return res.sendStatus(200)
    }
    const prevPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (prevPayload.payment_provider !== 'sonicpesa') {
      console.warn(LOG_PREFIX, 'webhook order not sonicpesa', orderId)
      return res.sendStatus(200)
    }
    if (txn.status === 'completed') {
      return res.sendStatus(200)
    }
    const ok = sonicPaymentSucceeded(body)
    const fail = sonicExplicitFailure(body)
    const nextStatus = ok ? 'completed' : fail ? 'failed' : txn.status
    const transId = body.transid ?? body.transaction_id ?? body.external_id
    await billing.updateTransactionByOrderId(orderId, {
      status: nextStatus,
      external_id: transId != null ? String(transId) : txn.external_id,
      raw_payload: {
        ...prevPayload,
        sonic_webhook: body,
        webhookAt: new Date().toISOString(),
      },
    })
    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId,
      status: nextStatus,
      deviceId: txn.device_id,
    })
    if (ok && txn.plan_id) {
      const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn({
        ...txn,
        status: 'completed',
      })
      if (!act.skipped && act.deviceId) {
        deviceSubscriptionBus.emit('update', { deviceId: act.deviceId })
        liveSyncBus.publish('analytics.subscription_updated', {
          topics: ['analytics'],
          deviceId: act.deviceId,
          orderId,
        })
      }
    }
    return res.sendStatus(200)
  } catch (e) {
    console.error(LOG_PREFIX, 'webhook error', e)
    return res.sendStatus(200)
  }
}

export async function testConnection(cred) {
  if (!cred.apiKey) {
    return { ok: false, message: 'Missing API key (admin or SONICPESA_API_KEY).' }
  }
  const base = apiBase(cred)
  try {
    const url = `${base}${collectPath()}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: authHeaders(cred),
      signal: ac.signal,
    })
    clearTimeout(timer)
    if (res.status === 200 || res.status === 204 || res.status === 405) {
      return {
        ok: true,
        message: `SonicPesa API reachable at ${base} (HTTP ${res.status}).`,
        httpStatus: res.status,
      }
    }
    const probe = await httpJson(base, { method: 'GET', headers: authHeaders(cred) })
    const authRejected = probe.status === 401 || probe.status === 403
    return {
      ok: probe.ok || authRejected,
      message: authRejected
        ? `API reachable; auth rejected (HTTP ${probe.status}) — check API key.`
        : probe.ok
          ? `API reachable (HTTP ${probe.status}).`
          : `HTTP ${probe.status}: ${JSON.stringify(probe.body).slice(0, 120)}`,
      httpStatus: probe.status,
    }
  } catch (e) {
    return {
      ok: false,
      message: e?.name === 'AbortError' ? 'Request timed out' : String(e.message || e),
      httpStatus: 0,
    }
  }
}
