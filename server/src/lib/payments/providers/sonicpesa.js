/**
 * SonicPesa payment provider (isolated — ZenoPay lives in zenopayClient.js).
 * @see https://docs.sonicpesa.com/pages/payments.html
 */
import crypto from 'node:crypto'
import {
  webhookExplicitFailure,
  webhookSuccess,
} from '../../../handlers/zenoPayWebhook.js'
import { notifySubscriptionActivatedFromAct } from '../../subscriptionActivationNotify.js'

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

function orderStatusPath() {
  const p = String(process.env.SONICPESA_ORDER_STATUS_PATH || '/payment/order_status').trim()
  return p.startsWith('/') ? p : `/${p}`
}

function authHeaders(cred) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-API-KEY': String(process.env.SONICPESA_API_KEY || cred.apiKey || '').trim(),
  }
  const secretKey = String(process.env.SONICPESA_SECRET_KEY || '').trim()
  if (secretKey) headers['X-SECRET-KEY'] = secretKey
  const accountId = String(process.env.SONICPESA_ACCOUNT_ID || cred.accountId || '').trim()
  if (accountId) {
    headers['X-Account-Id'] = accountId
    headers['X-Merchant-Id'] = accountId
  }
  return headers
}

/** Tanzania MSISDN for SonicPesa body: 255XXXXXXXXX (no +). */
function sonicBuyerPhone(phone) {
  let p = String(phone ?? '')
    .trim()
    .replace(/\D/g, '')
  if (!p) return ''
  if (p.startsWith('0')) p = `255${p.slice(1)}`
  if (p.startsWith('255')) return p
  if (p.length === 9) return `255${p}`
  return p
}

function maskPhoneForLog(phone) {
  const p = String(phone ?? '')
  if (p.length < 8) return '***'
  return `${p.slice(0, 6)}***${p.slice(-2)}`
}

function logPayloadForDebug(payload) {
  return {
    ...payload,
    buyer_phone: maskPhoneForLog(payload.buyer_phone),
  }
}

/**
 * SonicPesa may return HTTP 200 with status:"error" — treat body.status and data.order_id.
 */
export function isCreateOrderAccepted(httpRes) {
  if (!httpRes?.ok) return false
  const body = httpRes.body && typeof httpRes.body === 'object' ? httpRes.body : {}
  const topStatus = String(body.status ?? '').trim().toLowerCase()
  if (topStatus === 'error' || topStatus === 'failed') return false
  if (topStatus === 'success') return true
  const data = body.data && typeof body.data === 'object' ? body.data : null
  if (data?.order_id != null && String(data.order_id).trim() !== '') return true
  if (body.order_id != null && String(body.order_id).trim() !== '') return true
  if (body.success === true) return true
  return false
}

/**
 * Build POST /payment/create_order JSON per SonicPesa docs (buyer_phone = 255…, no +).
 */
export function buildCreateOrderPayload(cred, { phone, amount, orderId, currency = 'TZS' }) {
  const buyerPhone = sonicBuyerPhone(phone)
  const amountInt = Math.round(Number(amount))
  const accountId = String(process.env.SONICPESA_ACCOUNT_ID || cred?.accountId || '').trim()
  const payload = {
    buyer_email: String(process.env.SONICPESA_BUYER_EMAIL || 'customer@osmani.tv').trim(),
    buyer_name: String(process.env.SONICPESA_BUYER_NAME || 'Osmani Customer').trim(),
    buyer_phone: buyerPhone,
    amount: amountInt,
    currency: String(currency || 'TZS').trim() || 'TZS',
  }
  if (accountId) payload.account_id = accountId
  const merchantRef = String(orderId ?? '').trim()
  if (merchantRef && process.env.SONICPESA_INCLUDE_MERCHANT_REF === '1') {
    payload.merchant_order_id = merchantRef
    payload.reference = merchantRef
  }
  return { payload, buyerPhone, amountInt, merchantRef }
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
    data.payment_status ?? data.status ?? body.payment_status ?? '',
  ).trim()
  const transId = String(
    data.transid ?? data.transaction_id ?? data.trans_id ?? body.transid ?? '',
  ).trim()
  const message = String(body.message ?? data.message ?? '').trim()
  /** API wrapper `status:"success"` ≠ paid — use payment_status + same settlement rules as ZenoPay reconcile. */
  const succeeded =
    ['SUCCESS', 'COMPLETED', 'PAID'].includes(paymentStatus.toUpperCase()) ||
    webhookSuccess(body)
  const failed =
    ['FAILED', 'DECLINED', 'CANCELLED', 'REJECTED', 'USERCANCELLED'].includes(
      paymentStatus.toUpperCase(),
    ) ||
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
  const built = buildCreateOrderPayload(cred, { phone, amount, orderId, currency })
  const { payload, buyerPhone, amountInt, merchantRef } = built
  if (!buyerPhone || !buyerPhone.startsWith('255') || buyerPhone.length < 12) {
    return {
      ok: false,
      httpOk: false,
      status: 0,
      body: { error: 'buyer_phone must be valid Tanzania 255XXXXXXXXX' },
      normalized: null,
      requestPayload: payload,
    }
  }
  if (!Number.isFinite(amountInt) || amountInt <= 0) {
    return {
      ok: false,
      httpOk: false,
      status: 0,
      body: { error: 'amount must be a positive integer' },
      normalized: null,
      requestPayload: payload,
    }
  }
  const headerMeta = authHeaders(cred)
  console.log(LOG_PREFIX, 'createOrder request', {
    url,
    merchantRef,
    headers: {
      'X-API-KEY': headerMeta['X-API-KEY'] ? `${headerMeta['X-API-KEY'].slice(0, 6)}…` : '(missing)',
      'X-SECRET-KEY': headerMeta['X-SECRET-KEY'] ? '(set)' : '(not set)',
      'X-Account-Id': headerMeta['X-Account-Id'] || '(not set)',
    },
    body: logPayloadForDebug(payload),
    accountInBody: Boolean(payload.account_id),
  })
  const res = await httpJson(url, { method: 'POST', headers: headerMeta, body: payload })
  const accepted = isCreateOrderAccepted(res)
  const normalized = normalizeResponse(res.body, res.status)
  console.log(LOG_PREFIX, 'createOrder response', {
    url,
    merchantRef,
    httpStatus: res.status,
    httpOk: res.ok,
    accepted,
    body: res.body,
  })
  return {
    ...res,
    ok: accepted,
    httpOk: res.ok,
    normalized,
    merchantOrderId: merchantRef,
    requestPayload: payload,
  }
}

/**
 * Poll / verify payment status by merchant or provider order id.
 */
export async function verifyPayment(cred, orderId) {
  const oid = String(orderId ?? '').trim()
  if (!oid) {
    return { ok: false, status: 0, body: { error: 'order_id is required' }, normalized: null }
  }
  const envFull = String(process.env.SONICPESA_ORDER_STATUS_URL || '').trim()
  const url = envFull
    ? envFull.replace(/\/+$/, '')
    : `${apiBase(cred)}${orderStatusPath()}`
  const payload = { order_id: oid }
  console.log(LOG_PREFIX, 'verifyPayment request', { url, order_id: oid })
  const res = await httpJson(url, {
    method: 'POST',
    headers: authHeaders(cred),
    body: payload,
  })
  const normalized = normalizeResponse(res.body, res.status)
  console.log(LOG_PREFIX, 'verifyPayment response', {
    httpStatus: res.status,
    payment_status: normalized.paymentStatus,
    succeeded: normalized.succeeded,
    failed: normalized.failed,
    body: res.body,
  })
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

function webhookOrderIdCandidates(body) {
  const o = body && typeof body === 'object' ? body : {}
  const nested = [o.data, o.payment, o.payload, o.transaction].filter(
    (x) => x && typeof x === 'object',
  )
  const objs = [o, ...nested]
  const keys = [
    'order_id',
    'orderId',
    'merchant_order_id',
    'merchant_reference',
    'reference',
    'tx_ref',
  ]
  const out = []
  const seen = new Set()
  for (const obj of objs) {
    for (const k of keys) {
      const v = String(obj[k] ?? '').trim()
      if (v && !seen.has(v)) {
        seen.add(v)
        out.push(v)
      }
    }
  }
  return out
}

async function resolveTransactionForWebhook(billing, body) {
  const ids = webhookOrderIdCandidates(body)
  for (const id of ids) {
    const txn = await billing.getTransactionByOrderId(id)
    if (txn) return { txn, merchantOrderId: String(txn.order_id) }
  }
  for (const id of ids) {
    const txn = await billing.getTransactionByExternalId(id)
    if (txn) return { txn, merchantOrderId: String(txn.order_id) }
  }
  return { txn: null, merchantOrderId: null, candidateIds: ids }
}

/**
 * Process SonicPesa webhook (injected billing + bus deps to keep provider free of route wiring).
 */
export async function handleWebhook(req, res, deps) {
  const body = req.body && typeof req.body === 'object' ? req.body : {}
  const { billing, liveSyncBus, deviceSubscriptionBus, recordWebhookMeta } = deps
  try {
    console.log(LOG_PREFIX, 'webhook received', {
      candidateIds: webhookOrderIdCandidates(body),
      payment_status:
        body?.payment_status ?? body?.data?.payment_status ?? body?.status ?? null,
    })
    if (!verifyWebhookSignature(req, body)) {
      console.warn(LOG_PREFIX, 'webhook invalid signature')
      return res.status(401).type('text/plain').send('invalid signature')
    }
    if (typeof recordWebhookMeta === 'function') {
      await recordWebhookMeta(body)
    }
    const resolved = await resolveTransactionForWebhook(billing, body)
    const { txn, merchantOrderId, candidateIds } = resolved
    if (!txn || !merchantOrderId) {
      console.warn(LOG_PREFIX, 'webhook unknown order', { candidateIds })
      return res.sendStatus(200)
    }
    const prevPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (prevPayload.payment_provider !== 'sonicpesa') {
      console.warn(LOG_PREFIX, 'webhook order not sonicpesa', merchantOrderId)
      return res.sendStatus(200)
    }
    if (txn.status === 'completed') {
      const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn({
        ...txn,
        status: 'completed',
        order_id: merchantOrderId,
      })
      if (!act.skipped && act.deviceId) {
        notifySubscriptionActivatedFromAct(act, merchantOrderId)
      }
      console.log(LOG_PREFIX, 'webhook already completed — activation repair', {
        merchantOrderId,
        activated: act.activated === true,
        reason: act.reason,
      })
      return res.sendStatus(200)
    }
    const ok = sonicPaymentSucceeded(body)
    const fail = sonicExplicitFailure(body)
    const nextStatus = ok ? 'completed' : fail ? 'failed' : txn.status
    const data = body.data && typeof body.data === 'object' ? body.data : body
    const transId =
      data.transid ?? data.transaction_id ?? body.transid ?? body.transaction_id ?? body.external_id
    const providerOrderId = String(data.order_id ?? body.order_id ?? txn.external_id ?? '').trim()
    console.log(LOG_PREFIX, 'webhook apply', {
      merchantOrderId,
      providerOrderId: providerOrderId || null,
      ok,
      fail,
      nextStatus,
    })
    await billing.updateTransactionByOrderId(merchantOrderId, {
      status: nextStatus,
      external_id:
        transId != null
          ? String(transId)
          : providerOrderId || txn.external_id,
      raw_payload: {
        ...prevPayload,
        provider_order_id: providerOrderId || prevPayload.provider_order_id,
        sonic_webhook: body,
        webhookAt: new Date().toISOString(),
      },
    })
    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId: merchantOrderId,
      status: nextStatus,
      deviceId: txn.device_id,
    })
    if (ok && txn.plan_id) {
      const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn({
        ...txn,
        status: 'completed',
        order_id: merchantOrderId,
      })
      console.log(LOG_PREFIX, 'webhook activation', {
        merchantOrderId,
        activated: act.activated === true,
        reason: act.reason,
        deviceId: act.deviceId ? `${String(act.deviceId).slice(0, 12)}…` : null,
      })
      if (!act.skipped && act.deviceId) {
        notifySubscriptionActivatedFromAct(act, merchantOrderId)
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
