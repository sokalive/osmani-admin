/**
 * Aurax Pay payment provider (additive — ZenoPay + SonicPesa unchanged).
 * Default contract: Trawx-style mobile money (POST {origin}/api/create-order, code 101).
 * Also supports Zeno-style and SonicPesa-style via AURAXPAY_API_STYLE + path overrides.
 */
import crypto from 'node:crypto'
import {
  webhookExplicitFailure,
  webhookSuccess,
} from '../../../handlers/zenoPayWebhook.js'
import { formatPhone } from '../../../zenopayClient.js'

const DEFAULT_API_BASE = ''
const LOG_PREFIX = '[auraxpay]'
/** Trawx / Aurax Pay mobile-money collect path (see trawx.readme.io mobile-money). */
const AURAXPAY_DEFAULT_COLLECT_PATH = '/api/create-order'

const KNOWN_COLLECT_PATH_SUFFIXES = [
  '/api/create-order',
  '/payment/create_order',
  '/api/payments/mobile_money_tanzania',
]

export function isAuraxpayConfigured(cred) {
  const c = cred && typeof cred === 'object' ? cred : {}
  return Boolean(String(c.apiKey ?? '').trim()) && Boolean(String(c.apiEndpoint ?? '').trim())
}

export function resolveAuraxpayCredentials(row) {
  const r = row && typeof row === 'object' ? row : {}
  const apiEndpoint = String(process.env.AURAXPAY_ENDPOINT || r.api_endpoint || DEFAULT_API_BASE).trim()
  return {
    apiKey: String(process.env.AURAXPAY_API_KEY || r.api_key || '').trim(),
    accountId: String(process.env.AURAXPAY_ACCOUNT_ID || r.account_id || '').trim(),
    apiEndpoint: apiEndpoint.replace(/\/+$/, ''),
    webhookUrl: String(process.env.AURAXPAY_WEBHOOK_URL || r.webhook_url || '').trim(),
    environment: String(r.environment || 'sandbox').trim(),
  }
}

function apiBase(cred) {
  const ep = String(cred?.apiEndpoint || DEFAULT_API_BASE).trim().replace(/\/+$/, '')
  return ep
}

function collectPath() {
  const p = String(process.env.AURAXPAY_COLLECT_PATH || AURAXPAY_DEFAULT_COLLECT_PATH).trim()
  return p.startsWith('/') ? p : `/${p}`
}

function orderStatusPath() {
  const p = String(process.env.AURAXPAY_ORDER_STATUS_PATH || '/payment/order_status').trim()
  return p.startsWith('/') ? p : `/${p}`
}

function isHttpsUrl(url) {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** trawx (Aurax default) | zenoapi | sonicpesa-style APIs. */
export function detectAuraxpayApiStyle(cred) {
  const forced = String(process.env.AURAXPAY_API_STYLE || '').trim().toLowerCase()
  if (forced === 'zenopay' || forced === 'zeno') return 'zenopay'
  if (forced === 'sonicpesa' || forced === 'sonic') return 'sonicpesa'
  if (forced === 'trawx' || forced === 'aurax') return 'trawx'
  const base = apiBase(cred).toLowerCase()
  if (
    base.includes('zenoapi') ||
    base.includes('mobile_money') ||
    base.includes('zeno.africa') ||
    base.includes('zenopay')
  ) {
    return 'zenopay'
  }
  if (base.includes('sonicpesa')) return 'sonicpesa'
  if (base.includes('aurax') || base.includes('trawx')) return 'trawx'
  return 'trawx'
}

export function resolveAuraxpayCollectPostUrl(cred) {
  const envFull = String(
    process.env.AURAXPAY_COLLECT_URL || process.env.AURAXPAY_PAYMENT_URL || '',
  ).trim()
  if (envFull) return envFull.replace(/\/+$/, '')

  const ep = String(cred?.apiEndpoint || '').trim()
  if (!ep) return ''

  const configured = String(process.env.AURAXPAY_COLLECT_PATH || AURAXPAY_DEFAULT_COLLECT_PATH).trim()
  if (/^https?:\/\//i.test(configured)) return configured.replace(/\/+$/, '')

  const pathSuffix = (configured.startsWith('/') ? configured : `/${configured}`).replace(/\/+$/, '')

  try {
    const u = new URL(ep)
    let pathname = (u.pathname || '/').replace(/\/+$/, '') || ''
    for (const suffix of KNOWN_COLLECT_PATH_SUFFIXES) {
      if (pathname.endsWith(suffix)) {
        return `${u.origin}${pathname}`.replace(/\/+$/, '')
      }
    }
    const style = detectAuraxpayApiStyle(cred)
    // Trawx/Aurax: POST {origin}/api/create-order — not under /v1/payment/create_order
    if (style === 'trawx') {
      return `${u.origin}${pathSuffix}`
    }
    const base = !pathname || pathname === '/' ? u.origin : `${u.origin}${pathname}`
    return `${base.replace(/\/+$/, '')}${pathSuffix}`
  } catch {
    return ''
  }
}

function authHeaders(cred, style = 'trawx') {
  const apiKey = String(process.env.AURAXPAY_API_KEY || cred.apiKey || '').trim()
  if (style === 'zenopay') {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': apiKey,
    }
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-API-Key': apiKey,
    'X-API-KEY': apiKey,
  }
  const secretKey = String(process.env.AURAXPAY_SECRET_KEY || '').trim()
  if (secretKey) headers['X-SECRET-KEY'] = secretKey
  const accountId = String(process.env.AURAXPAY_ACCOUNT_ID || cred.accountId || '').trim()
  if (accountId) {
    headers['X-Account-Id'] = accountId
    headers['X-Merchant-Id'] = accountId
  }
  return headers
}

function logPayloadForDebug(payload) {
  const out = { ...payload }
  if (out.buyer_phone) out.buyer_phone = maskPhoneForLog(out.buyer_phone)
  if (out.customer_phone) out.customer_phone = maskPhoneForLog(out.customer_phone)
  return out
}

function buyerPhone(phone) {
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

export function isCreateOrderAccepted(httpRes) {
  if (!httpRes?.ok) return false
  const body = httpRes.body && typeof httpRes.body === 'object' ? httpRes.body : {}
  const numericStatus = Number(body.status)
  if (numericStatus === 203) return true
  const result = String(body.result ?? '').trim().toLowerCase()
  if (result === 'dispatched' || result === 'success') return true
  const topStatus = String(body.status ?? '').trim().toLowerCase()
  if (topStatus === 'error' || topStatus === 'failed') return false
  if (topStatus === 'success') return true
  const data = body.data && typeof body.data === 'object' ? body.data : null
  if (data?.order_id != null && String(data.order_id).trim() !== '') return true
  if (body.order_id != null && String(body.order_id).trim() !== '') return true
  if (body.success === true) return true
  return false
}

export function buildCreateOrderPayload(cred, { phone, amount, orderId, currency = 'TZS' }) {
  const apiStyle = detectAuraxpayApiStyle(cred)
  const amountInt = Math.round(Number(amount))
  const merchantRef = String(orderId ?? '').trim()
  const accountId = String(process.env.AURAXPAY_ACCOUNT_ID || cred?.accountId || '').trim()
  const webhookUrl = String(process.env.AURAXPAY_WEBHOOK_URL || cred?.webhookUrl || '').trim()

  if (apiStyle === 'zenopay') {
    const buyer_phone = formatPhone(phone)
    const payload = {
      order_id: merchantRef,
      reference: merchantRef,
      buyer_name: String(process.env.AURAXPAY_BUYER_NAME || 'Osmani Customer').trim(),
      buyer_phone,
      buyer_email: String(process.env.AURAXPAY_BUYER_EMAIL || 'customer@osmani.tv').trim(),
      amount: amountInt,
    }
    if (accountId) payload.account_id = accountId
    if (webhookUrl && isHttpsUrl(webhookUrl)) payload.webhook_url = webhookUrl
    return { payload, buyerPhone: buyer_phone, amountInt, merchantRef, apiStyle }
  }

  if (apiStyle === 'trawx') {
    const customer_phone = buyerPhone(phone)
    const payload = {
      code: 101,
      merchant_order_id: merchantRef,
      amount: amountInt,
      currency: String(currency || 'TZS').trim() || 'TZS',
      merchant_webhook: webhookUrl,
      product_count: 1,
      customer_email: String(process.env.AURAXPAY_BUYER_EMAIL || 'customer@osmani.tv').trim(),
      customer_name: String(process.env.AURAXPAY_BUYER_NAME || 'Osmani Customer').trim(),
      customer_phone,
      customer_userid: accountId || merchantRef.slice(0, 100),
    }
    return { payload, buyerPhone: customer_phone, amountInt, merchantRef, apiStyle }
  }

  const buyer_phone = buyerPhone(phone)
  const payload = {
    buyer_email: String(process.env.AURAXPAY_BUYER_EMAIL || 'customer@osmani.tv').trim(),
    buyer_name: String(process.env.AURAXPAY_BUYER_NAME || 'Osmani Customer').trim(),
    buyer_phone,
    amount: amountInt,
    currency: String(currency || 'TZS').trim() || 'TZS',
  }
  if (accountId) payload.account_id = accountId
  if (webhookUrl && isHttpsUrl(webhookUrl)) payload.webhook_url = webhookUrl
  if (merchantRef && process.env.AURAXPAY_INCLUDE_MERCHANT_REF === '1') {
    payload.merchant_order_id = merchantRef
    payload.reference = merchantRef
  }
  return { payload, buyerPhone: buyer_phone, amountInt, merchantRef, apiStyle }
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
  const succeeded =
    ['SUCCESS', 'COMPLETED', 'PAID', 'APPROVED'].includes(paymentStatus.toUpperCase()) ||
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

export async function createOrder(cred, { phone, amount, orderId, currency = 'TZS' }) {
  const url = resolveAuraxpayCollectPostUrl(cred)
  if (!url) {
    return {
      ok: false,
      httpOk: false,
      status: 0,
      body: { error: 'Aurax Pay API endpoint is not configured' },
      normalized: null,
      requestPayload: null,
    }
  }
  const built = buildCreateOrderPayload(cred, { phone, amount, orderId, currency })
  const { payload, buyerPhone: bp, amountInt, merchantRef, apiStyle } = built
  const accountId = String(process.env.AURAXPAY_ACCOUNT_ID || cred?.accountId || '').trim()
  const webhookUrl = String(process.env.AURAXPAY_WEBHOOK_URL || cred?.webhookUrl || '').trim()

  if (apiStyle === 'zenopay') {
    if (!bp || !bp.startsWith('+255')) {
      return {
        ok: false,
        httpOk: false,
        status: 0,
        body: { error: 'buyer_phone must be valid Tanzania +255… for Zeno-style Aurax API' },
        normalized: null,
        requestPayload: payload,
        apiStyle,
      }
    }
    if (!accountId) {
      return {
        ok: false,
        httpOk: false,
        status: 0,
        body: { error: 'account_id is required (AURAXPAY_ACCOUNT_ID or admin account id)' },
        normalized: null,
        requestPayload: payload,
        apiStyle,
      }
    }
    if (!webhookUrl || !isHttpsUrl(webhookUrl)) {
      return {
        ok: false,
        httpOk: false,
        status: 0,
        body: { error: 'webhook_url must be a valid https URL in Aurax Pay settings' },
        normalized: null,
        requestPayload: payload,
        apiStyle,
      }
    }
  } else if (apiStyle === 'trawx') {
    if (!bp || !bp.startsWith('255') || bp.length < 12) {
      return {
        ok: false,
        httpOk: false,
        status: 0,
        body: { error: 'customer_phone must be valid Tanzania 255XXXXXXXXX' },
        normalized: null,
        requestPayload: payload,
        apiStyle,
      }
    }
    if (!webhookUrl || !isHttpsUrl(webhookUrl)) {
      return {
        ok: false,
        httpOk: false,
        status: 0,
        body: { error: 'merchant_webhook must be a valid https URL in Aurax Pay settings' },
        normalized: null,
        requestPayload: payload,
        apiStyle,
      }
    }
    if (amountInt < 1000) {
      return {
        ok: false,
        httpOk: false,
        status: 0,
        body: { error: 'amount must be at least 1000 TZS for Aurax mobile money' },
        normalized: null,
        requestPayload: payload,
        apiStyle,
      }
    }
  } else if (!bp || !bp.startsWith('255') || bp.length < 12) {
    return {
      ok: false,
      httpOk: false,
      status: 0,
      body: { error: 'buyer_phone must be valid Tanzania 255XXXXXXXXX' },
      normalized: null,
      requestPayload: payload,
      apiStyle,
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
      apiStyle,
    }
  }

  const headerMeta = authHeaders(cred, apiStyle)
  console.log(LOG_PREFIX, 'createOrder request', {
    url,
    apiStyle,
    merchantRef,
    headers: {
      'x-api-key': headerMeta['x-api-key'] || headerMeta['X-API-KEY'] ? '(set)' : '(missing)',
      'X-SECRET-KEY': headerMeta['X-SECRET-KEY'] ? '(set)' : '(not set)',
      'X-Account-Id': headerMeta['X-Account-Id'] || '(not set)',
    },
    body: logPayloadForDebug(payload),
    accountInBody: Boolean(payload.account_id),
    webhookInBody: Boolean(payload.webhook_url),
  })

  const res = await httpJson(url, { method: 'POST', headers: headerMeta, body: payload })
  const accepted = isCreateOrderAccepted(res)
  const normalized = normalizeResponse(res.body, res.status)
  const providerMessage = String(
    res.body?.message ?? res.body?.error ?? res.body?.data?.message ?? '',
  ).trim()

  console.log(LOG_PREFIX, 'createOrder response', {
    url,
    apiStyle,
    merchantRef,
    httpStatus: res.status,
    httpOk: res.ok,
    accepted,
    providerMessage: providerMessage || null,
    body: res.body,
  })

  return {
    ...res,
    ok: accepted,
    httpOk: res.ok,
    normalized,
    merchantOrderId: merchantRef,
    requestPayload: payload,
    apiStyle,
    providerMessage,
  }
}

export async function verifyPayment(cred, orderId) {
  const oid = String(orderId ?? '').trim()
  if (!oid) {
    return { ok: false, status: 0, body: { error: 'order_id is required' }, normalized: null }
  }
  const base = apiBase(cred)
  if (!base) {
    return { ok: false, status: 0, body: { error: 'API endpoint not configured' }, normalized: null }
  }
  const envFull = String(process.env.AURAXPAY_ORDER_STATUS_URL || '').trim()
  const url = envFull ? envFull.replace(/\/+$/, '') : `${base}${orderStatusPath()}`
  const payload = { order_id: oid }
  const res = await httpJson(url, {
    method: 'POST',
    headers: authHeaders(cred),
    body: payload,
  })
  const normalized = normalizeResponse(res.body, res.status)
  return { ...res, normalized }
}

export function auraxPaymentSucceeded(body) {
  return normalizeResponse(body).succeeded
}

export function auraxExplicitFailure(body) {
  return normalizeResponse(body).failed
}

export function verifyWebhookSignature(req, body) {
  const secret = String(process.env.AURAXPAY_WEBHOOK_SECRET || '').trim()
  if (!secret) return true
  const rawSig = String(
    req.headers['x-auraxpay-signature'] ?? req.headers['x-webhook-signature'] ?? '',
  ).trim()
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
    const resolved = await resolveTransactionForWebhook(billing, body)
    const { txn, merchantOrderId, candidateIds } = resolved
    if (!txn || !merchantOrderId) {
      console.warn(LOG_PREFIX, 'webhook unknown order', { candidateIds })
      return res.sendStatus(200)
    }
    const prevPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (prevPayload.payment_provider !== 'auraxpay') {
      console.warn(LOG_PREFIX, 'webhook order not auraxpay', merchantOrderId)
      return res.sendStatus(200)
    }
    if (txn.status === 'completed') {
      return res.sendStatus(200)
    }
    const ok = auraxPaymentSucceeded(body)
    const fail = auraxExplicitFailure(body)
    const nextStatus = ok ? 'completed' : fail ? 'failed' : txn.status
    const data = body.data && typeof body.data === 'object' ? body.data : body
    const transId =
      data.transid ?? data.transaction_id ?? body.transid ?? body.transaction_id ?? body.external_id
    const providerOrderId = String(data.order_id ?? body.order_id ?? txn.external_id ?? '').trim()
    await billing.updateTransactionByOrderId(merchantOrderId, {
      status: nextStatus,
      external_id:
        transId != null ? String(transId) : providerOrderId || txn.external_id,
      raw_payload: {
        ...prevPayload,
        provider_order_id: providerOrderId || prevPayload.provider_order_id,
        aurax_webhook: body,
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
      if (!act.skipped && act.deviceId) {
        deviceSubscriptionBus.emit('update', { deviceId: act.deviceId })
        liveSyncBus.publish('analytics.subscription_updated', {
          topics: ['analytics'],
          deviceId: act.deviceId,
          orderId: merchantOrderId,
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
    return { ok: false, message: 'Missing API key (admin or AURAXPAY_API_KEY).' }
  }
  const base = apiBase(cred)
  if (!base) {
    return { ok: false, message: 'API endpoint is required (admin or AURAXPAY_ENDPOINT).' }
  }
  const apiStyle = detectAuraxpayApiStyle(cred)
  const collectUrl = resolveAuraxpayCollectPostUrl(cred)
  try {
    const url = collectUrl || `${base}${collectPath()}`
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 15_000)
    const res = await fetch(url, {
      method: 'OPTIONS',
      headers: authHeaders(cred, apiStyle),
      signal: ac.signal,
    })
    clearTimeout(timer)
    if (res.status === 200 || res.status === 204 || res.status === 405) {
      return {
        ok: true,
        message: `Aurax Pay collect URL reachable (${url}, HTTP ${res.status}).`,
        httpStatus: res.status,
        apiStyle,
        collectUrl: url,
      }
    }
    const probe = await httpJson(base, { method: 'GET', headers: authHeaders(cred, apiStyle) })
    const authRejected = probe.status === 401 || probe.status === 403
    return {
      ok: probe.ok || authRejected,
      message: authRejected
        ? `API reachable; auth rejected (HTTP ${probe.status}) — check API key. Collect URL: ${url}`
        : probe.ok
          ? `API reachable (HTTP ${probe.status}). Collect URL: ${url}`
          : `HTTP ${probe.status}: ${JSON.stringify(probe.body).slice(0, 120)} (collect: ${url})`,
      httpStatus: probe.status,
      apiStyle,
      collectUrl: url,
    }
  } catch (e) {
    return {
      ok: false,
      message: e?.name === 'AbortError' ? 'Request timed out' : String(e.message || e),
      httpStatus: 0,
    }
  }
}
