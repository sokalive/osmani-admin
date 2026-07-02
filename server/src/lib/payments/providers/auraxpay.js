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
import { notifySubscriptionActivatedFromAct } from '../../subscriptionActivationNotify.js'

const DEFAULT_API_BASE = ''
const LOG_PREFIX = '[auraxpay]'
/** Native Aurax Pay mobile-money USSD push — POST {base}/payments/collect */
const AURAXPAY_NATIVE_COLLECT_PATH = '/payments/collect'
/** Trawx white-label mobile-money — POST {origin}/api/create-order */
const AURAXPAY_TRAWX_COLLECT_PATH = '/api/create-order'

const KNOWN_COLLECT_PATH_SUFFIXES = [
  '/payments/collect',
  '/payments/create-order',
  '/api/create-order',
  '/payment/create_order',
  '/api/payments/mobile_money_tanzania',
]

export function isAuraxpayConfigured(cred) {
  const c = cred && typeof cred === 'object' ? cred : {}
  return Boolean(String(c.apiKey ?? '').trim()) && Boolean(String(c.apiEndpoint ?? '').trim())
}

/** Merchant account id is the payout phone — normalize to 255XXXXXXXXX. */
export function normalizeAuraxpayAccountId(raw) {
  let p = String(raw ?? '')
    .trim()
    .replace(/\D/g, '')
  if (!p) return ''
  if (p.startsWith('0')) p = `255${p.slice(1)}`
  if (!p.startsWith('255') && p.length === 9) p = `255${p}`
  if (/^255\d{9}$/.test(p)) return p
  return p
}

export function resolveAuraxpayCredentials(row) {
  const r = row && typeof row === 'object' ? row : {}
  const rawEndpoint = String(
    process.env.AURAXPAY_ENDPOINT ||
      process.env.AURAXPAY_BASE_URL ||
      r.api_endpoint ||
      DEFAULT_API_BASE,
  ).trim()
  const apiEndpoint = normalizeAuraxpayApiEndpoint(rawEndpoint)
  const rawKey = String(process.env.AURAXPAY_API_KEY || r.api_key || '').trim()
  const apiKey = rawKey.replace(/^Bearer\s+/i, '').replace(/^["']|["']$/g, '')
  const signingSecret = String(
    process.env.AURAXPAY_SIGNING_SECRET ||
      process.env.AURAXPAY_SECRET_KEY ||
      process.env.AURAXPAY_WEBHOOK_SECRET ||
      r.webhook_secret ||
      '',
  ).trim()
  const accountRaw = String(process.env.AURAXPAY_ACCOUNT_ID || r.account_id || '').trim()
  const accountId = accountRaw ? normalizeAuraxpayAccountId(accountRaw) : ''
  return {
    apiKey,
    signingSecret,
    accountId,
    apiEndpoint,
    webhookUrl: String(process.env.AURAXPAY_WEBHOOK_URL || r.webhook_url || '').trim(),
    environment: String(r.environment || 'sandbox').trim(),
  }
}

/** Strip collect/status path suffixes; ensure native api.auraxpay.* hosts use /v1 base. */
export function normalizeAuraxpayApiEndpoint(raw) {
  let ep = String(raw || '').trim().replace(/\/+$/, '')
  if (!ep) return ''
  try {
    const u = new URL(ep)
    let pathname = (u.pathname || '/').replace(/\/+$/, '') || ''
    for (const suffix of KNOWN_COLLECT_PATH_SUFFIXES) {
      if (pathname.endsWith(suffix)) {
        pathname = pathname.slice(0, -suffix.length).replace(/\/+$/, '')
        break
      }
    }
    if (u.hostname.includes('auraxpay') && (!pathname || pathname === '/')) {
      pathname = '/v1'
    }
    return pathname ? `${u.origin}${pathname}` : u.origin
  } catch {
    return ep
  }
}

function isAuraxpayNativeHost(endpointOrCred) {
  const ep =
    typeof endpointOrCred === 'string'
      ? endpointOrCred
      : String(endpointOrCred?.apiEndpoint || '').trim()
  if (!ep) return false
  try {
    return new URL(ep).hostname.toLowerCase().includes('auraxpay')
  } catch {
    return ep.toLowerCase().includes('auraxpay')
  }
}

/** Ensure native api.auraxpay.* collect URLs include /v1 (avoids 404 Endpoint not found). */
export function normalizeAuraxpayCollectUrl(url) {
  let s = String(url || '').trim().replace(/\/+$/, '')
  if (!s) return ''
  try {
    const u = new URL(s)
    if (!u.hostname.toLowerCase().includes('auraxpay')) return s
    let pathname = (u.pathname || '/').replace(/\/+$/, '') || ''
    if (pathname === '/payment/create_order' || pathname === '/v1/payment/create_order') {
      pathname = '/v1/payments/collect'
    } else if (pathname.startsWith('/payments/') || pathname.startsWith('/payment/')) {
      if (!pathname.startsWith('/v1/')) pathname = `/v1${pathname.replace(/^\/payment\//, '/payments/')}`
    } else if (!pathname || pathname === '/') {
      pathname = `/v1${AURAXPAY_NATIVE_COLLECT_PATH}`
    }
    return `${u.origin}${pathname}`
  } catch {
    return s
  }
}

function apiBase(cred) {
  const ep = String(cred?.apiEndpoint || DEFAULT_API_BASE).trim().replace(/\/+$/, '')
  return ep
}

function collectPathForStyle(style, cred) {
  const fallback =
    style === 'trawx' ? AURAXPAY_TRAWX_COLLECT_PATH : AURAXPAY_NATIVE_COLLECT_PATH
  const configured = String(process.env.AURAXPAY_COLLECT_PATH || '').trim()
  if (style === 'aurax' && isAuraxpayNativeHost(cred)) {
    if (!configured || configured === '/payment/create_order' || configured === 'payment/create_order') {
      if (configured) {
        console.warn(LOG_PREFIX, 'ignoring legacy AURAXPAY_COLLECT_PATH on native auraxpay host', {
          configured,
          using: AURAXPAY_NATIVE_COLLECT_PATH,
        })
      }
      return AURAXPAY_NATIVE_COLLECT_PATH
    }
    if (/^https?:\/\//i.test(configured)) return configured
    const p = configured.startsWith('/') ? configured : `/${configured}`
    if (p === '/payments/collect') return p
    if (p === '/payments/create-order') {
      console.warn(LOG_PREFIX, 'ignoring /payments/create-order on native auraxpay host', {
        using: AURAXPAY_NATIVE_COLLECT_PATH,
      })
      return AURAXPAY_NATIVE_COLLECT_PATH
    }
    console.warn(LOG_PREFIX, 'ignoring non-native AURAXPAY_COLLECT_PATH on auraxpay host', {
      configured: p,
      using: AURAXPAY_NATIVE_COLLECT_PATH,
    })
    return AURAXPAY_NATIVE_COLLECT_PATH
  }
  const p = configured || fallback
  return p.startsWith('/') ? p : `/${p}`
}

function orderStatusPath(style, cred) {
  const nativeDefault = '/payments/status'
  const legacyDefault = '/payment/order_status'
  const configured = String(process.env.AURAXPAY_ORDER_STATUS_PATH || '').trim()
  if (style === 'aurax' && isAuraxpayNativeHost(cred)) {
    if (!configured || configured === '/payment/order_status' || configured === 'payment/order_status') {
      return nativeDefault
    }
    const p = configured.startsWith('/') ? configured : `/${configured}`
    if (p.startsWith('/payments/')) return p
    console.warn(LOG_PREFIX, 'ignoring non-native AURAXPAY_ORDER_STATUS_PATH on auraxpay host', {
      configured: p,
      using: nativeDefault,
    })
    return nativeDefault
  }
  const p = configured || legacyDefault
  return p.startsWith('/') ? p : `/${p}`
}

function isHttpsUrl(url) {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/** aurax (native api.auraxpay.*) | trawx | zenoapi | sonicpesa-style APIs. */
export function detectAuraxpayApiStyle(cred) {
  if (isAuraxpayNativeHost(cred)) return 'aurax'
  const forced = String(process.env.AURAXPAY_API_STYLE || '').trim().toLowerCase()
  if (forced === 'zenopay' || forced === 'zeno') return 'zenopay'
  if (forced === 'sonicpesa' || forced === 'sonic') return 'sonicpesa'
  if (forced === 'trawx') return 'trawx'
  if (forced === 'aurax' || forced === 'auraxnative' || forced === 'native') return 'aurax'
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
  if (base.includes('trawx')) return 'trawx'
  if (base.includes('auraxpay')) return 'aurax'
  return 'aurax'
}

/** Candidate POST URLs for native Aurax (collect first; create-order fallback on 404). */
export function listAuraxNativeCollectCandidateUrls(cred) {
  const primary = resolveAuraxpayCollectPostUrl(cred)
  if (!primary) return []
  if (isAuraxpayNativeHost(cred)) {
    const base = apiBase(cred).replace(/\/+$/, '')
    const collect = primary.endsWith('/payments/collect')
      ? primary
      : normalizeAuraxpayCollectUrl(`${base}${AURAXPAY_NATIVE_COLLECT_PATH}`)
    const createOrder = normalizeAuraxpayCollectUrl(`${base}/payments/create-order`)
    return [...new Set([collect, createOrder].filter(Boolean))]
  }
  const urls = [primary]
  try {
    const u = new URL(primary)
    const pathname = (u.pathname || '/').replace(/\/+$/, '')
    if (pathname.endsWith('/payments/create-order')) {
      urls.push(`${u.origin}${pathname.replace(/\/payments\/create-order$/, '/payments/collect')}`)
    } else if (pathname.endsWith('/payments/collect')) {
      urls.push(`${u.origin}${pathname.replace(/\/payments\/collect$/, '/payments/create-order')}`)
    }
  } catch {
    /* ignore */
  }
  return [...new Set(urls.map((x) => x.replace(/\/+$/, '')))]
}

function isLegacyNativeAuraxCollectUrl(url) {
  const lower = String(url || '').toLowerCase()
  return (
    lower.includes('/payment/create_order') ||
    lower.includes('/payments/create-order') ||
    lower.includes('/api/create-order')
  )
}

export function resolveAuraxpayCollectPostUrl(cred) {
  const envFull = String(
    process.env.AURAXPAY_COLLECT_URL || process.env.AURAXPAY_PAYMENT_URL || '',
  ).trim()
  if (envFull) {
    const normalized = normalizeAuraxpayCollectUrl(envFull.replace(/\/+$/, ''))
    if (isAuraxpayNativeHost(cred) && isLegacyNativeAuraxCollectUrl(normalized)) {
      console.warn(LOG_PREFIX, 'ignoring legacy AURAXPAY_COLLECT_URL on native auraxpay host', {
        configured: envFull,
        using: AURAXPAY_NATIVE_COLLECT_PATH,
      })
    } else {
      return normalized
    }
  }

  const ep = String(cred?.apiEndpoint || '').trim()
  if (!ep) return ''

  const style = detectAuraxpayApiStyle(cred)
  const configured = String(process.env.AURAXPAY_COLLECT_PATH || '').trim()
  if (/^https?:\/\//i.test(configured)) {
    return normalizeAuraxpayCollectUrl(configured.replace(/\/+$/, ''))
  }

  const pathSuffix = collectPathForStyle(style, cred).replace(/\/+$/, '')

  try {
    const u = new URL(ep)
    let pathname = (u.pathname || '/').replace(/\/+$/, '') || ''
    for (const suffix of KNOWN_COLLECT_PATH_SUFFIXES) {
      if (pathname.endsWith(suffix)) {
        return normalizeAuraxpayCollectUrl(`${u.origin}${pathname}`.replace(/\/+$/, ''))
      }
    }
    // Native Aurax: POST https://api.auraxpay.net/v1/payments/collect
    if (style === 'aurax') {
      if (!pathname || pathname === '/') {
        return normalizeAuraxpayCollectUrl(`${u.origin}/v1${pathSuffix}`)
      }
      const base = `${u.origin}${pathname}`.replace(/\/+$/, '')
      return normalizeAuraxpayCollectUrl(`${base}${pathSuffix}`)
    }
    // Trawx white-label: POST {origin}/api/create-order
    if (style === 'trawx') {
      return `${u.origin}${pathSuffix}`
    }
    const base = !pathname || pathname === '/' ? u.origin : `${u.origin}${pathname}`
    return normalizeAuraxpayCollectUrl(`${base.replace(/\/+$/, '')}${pathSuffix}`)
  } catch {
    return ''
  }
}

function authHeaders(cred, style = 'aurax') {
  const apiKey = String(process.env.AURAXPAY_API_KEY || cred.apiKey || '').trim()
  const signingSecret = String(
    process.env.AURAXPAY_SIGNING_SECRET ||
      process.env.AURAXPAY_SECRET_KEY ||
      process.env.AURAXPAY_WEBHOOK_SECRET ||
      cred?.signingSecret ||
      '',
  ).trim()
  if (style === 'zenopay' || style === 'aurax') {
    const headers = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'x-api-key': apiKey,
    }
    if (signingSecret) {
      headers['x-signing-secret'] = signingSecret
      headers['X-SECRET-KEY'] = signingSecret
    }
    const accountId = normalizeAuraxpayAccountId(
      String(process.env.AURAXPAY_ACCOUNT_ID || cred?.accountId || '').trim(),
    )
    if (accountId) {
      headers['X-Account-Id'] = accountId
      headers['X-Merchant-Id'] = accountId
    }
    return headers
  }
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'X-API-Key': apiKey,
    'X-API-KEY': apiKey,
  }
  const secretKey = String(process.env.AURAXPAY_SECRET_KEY || '').trim()
  if (secretKey) headers['X-SECRET-KEY'] = secretKey
  const accountId = normalizeAuraxpayAccountId(
    String(process.env.AURAXPAY_ACCOUNT_ID || cred.accountId || '').trim(),
  )
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
  if (out.phone) out.phone = maskPhoneForLog(out.phone)
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

export function isCreateOrderAccepted(httpRes, { apiStyle } = {}) {
  if (!httpRes?.ok) return false
  const body = httpRes.body && typeof httpRes.body === 'object' ? httpRes.body : {}
  const errText = String(body.error ?? body.message ?? '')
    .trim()
    .toLowerCase()
  if (errText === 'endpoint not found') return false
  const numericStatus = Number(body.status)
  if (numericStatus === 203) return true
  const result = String(body.result ?? '').trim().toLowerCase()
  if (result === 'dispatched' || result === 'success') return true
  const topStatus = String(body.status ?? '').trim().toLowerCase()
  if (topStatus === 'error' || topStatus === 'failed') return false
  if (topStatus === 'success' || topStatus === 'pending' || topStatus === 'initiated') return true
  const data = body.data && typeof body.data === 'object' ? body.data : null
  if (data?.order_id != null && String(data.order_id).trim() !== '') return true
  if (body.order_id != null && String(body.order_id).trim() !== '') return true
  if (body.success === true || body.accepted === true) return true
  if (apiStyle === 'aurax' && !body.error) return true
  return false
}

export function buildCreateOrderPayload(cred, { phone, amount, orderId, currency = 'TZS' }) {
  const apiStyle = detectAuraxpayApiStyle(cred)
  const amountInt = Math.round(Number(amount))
  const merchantRef = String(orderId ?? '').trim()
  const accountId = normalizeAuraxpayAccountId(
    String(process.env.AURAXPAY_ACCOUNT_ID || cred?.accountId || '').trim(),
  )
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

  if (apiStyle === 'aurax') {
    const phone255 = buyerPhone(phone)
    const payload = {
      phone: phone255,
      amount: amountInt,
      currency: String(currency || 'TZS').trim() || 'TZS',
      reference: merchantRef,
      callback_url: webhookUrl,
    }
    if (accountId) payload.account_id = accountId
    return { payload, buyerPhone: phone255, amountInt, merchantRef, apiStyle }
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
    ['SUCCESS', 'COMPLETED', 'PAID', 'APPROVED', 'SUCCEED', 'SUCCESSFUL'].includes(
      paymentStatus.toUpperCase(),
    ) ||
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
  const accountId = normalizeAuraxpayAccountId(
    String(process.env.AURAXPAY_ACCOUNT_ID || cred?.accountId || '').trim(),
  )
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
  } else if (apiStyle === 'aurax' || apiStyle === 'trawx') {
    if (!bp || !bp.startsWith('255') || bp.length < 12) {
      return {
        ok: false,
        httpOk: false,
        status: 0,
        body: {
          error:
            apiStyle === 'trawx'
              ? 'customer_phone must be valid Tanzania 255XXXXXXXXX'
              : 'phone must be valid Tanzania 255XXXXXXXXX',
        },
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
        body: {
          error:
            apiStyle === 'trawx'
              ? 'merchant_webhook must be a valid https URL in Aurax Pay settings'
              : 'callback_url must be a valid https URL in Aurax Pay settings',
        },
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
    if (apiStyle === 'aurax' && (!accountId || !/^255\d{9}$/.test(accountId))) {
      return {
        ok: false,
        httpOk: false,
        status: 0,
        body: {
          error:
            'account_id (merchant phone 255XXXXXXXXX) is required — set Merchant Account ID in Aurax Pay settings or AURAXPAY_ACCOUNT_ID',
        },
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
  const tryUrls =
    apiStyle === 'aurax' ? listAuraxNativeCollectCandidateUrls(cred) : [url]
  let res = null
  let usedUrl = url
  const attemptedUrls = []
  for (const tryUrl of tryUrls) {
    usedUrl = tryUrl
    attemptedUrls.push(tryUrl)
    console.log(LOG_PREFIX, 'createOrder request', {
      url: tryUrl,
      apiStyle,
      merchantRef,
      attempt: tryUrls.indexOf(tryUrl) + 1,
      of: tryUrls.length,
      headers: {
        'x-api-key': headerMeta['x-api-key'] || headerMeta['X-API-KEY'] ? '(set)' : '(missing)',
        'X-SECRET-KEY': headerMeta['X-SECRET-KEY'] ? '(set)' : '(not set)',
        'X-Account-Id': headerMeta['X-Account-Id'] || '(not set)',
      },
      body: logPayloadForDebug(payload),
      accountInBody: Boolean(payload.account_id),
      webhookInBody: Boolean(payload.callback_url || payload.webhook_url || payload.merchant_webhook),
    })
    res = await httpJson(tryUrl, { method: 'POST', headers: headerMeta, body: payload })
    const endpointMissing =
      res.status === 404 &&
      String(res.body?.error ?? '')
        .trim()
        .toLowerCase() === 'endpoint not found'
    if (!endpointMissing || tryUrl === tryUrls[tryUrls.length - 1]) break
    console.warn(LOG_PREFIX, 'createOrder retry after 404 Endpoint not found', {
      failedUrl: tryUrl,
      nextUrl: tryUrls[tryUrls.indexOf(tryUrl) + 1],
    })
  }
  const accepted = isCreateOrderAccepted(res, { apiStyle })
  const normalized = normalizeResponse(res.body, res.status)
  const providerMessage = String(
    res.body?.message ?? res.body?.error ?? res.body?.data?.message ?? '',
  ).trim()

  console.log(LOG_PREFIX, 'createOrder response', {
    url: usedUrl,
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
    collectUrl: usedUrl,
    attemptedUrls,
  }
}

/** Admin diagnostic: POST probe against native Aurax collect routes using stored credentials. */
export async function diagnoseAuraxpayCollectRoutes(cred) {
  const apiStyle = detectAuraxpayApiStyle(cred)
  const urls = apiStyle === 'aurax' ? listAuraxNativeCollectCandidateUrls(cred) : [resolveAuraxpayCollectPostUrl(cred)].filter(Boolean)
  const headerMeta = authHeaders(cred, apiStyle)
  const probeBody = {
    phone: '255700000000',
    amount: 1000,
    currency: 'TZS',
    reference: `osm_probe_${Date.now()}`,
    callback_url: String(cred.webhookUrl || process.env.AURAXPAY_WEBHOOK_URL || '').trim(),
  }
  if (cred.accountId) probeBody.account_id = cred.accountId
  const results = []
  for (const tryUrl of urls) {
    const res = await httpJson(tryUrl, { method: 'POST', headers: headerMeta, body: probeBody })
    results.push({
      url: tryUrl,
      httpStatus: res.status,
      body: res.body,
      providerMessage: String(res.body?.message ?? res.body?.error ?? '').trim() || null,
    })
  }
  return { apiStyle, probeBody: { ...probeBody, phone: '255700***' }, results }
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
  const apiStyle = detectAuraxpayApiStyle(cred)
  const statusPath = orderStatusPath(apiStyle, cred)
  let url = envFull ? envFull.replace(/\/+$/, '') : `${base}${statusPath}`
  if (apiStyle === 'aurax' && isAuraxpayNativeHost(cred)) {
    if (
      !envFull ||
      url.includes('/payment/order_status') ||
      url.includes('/payment/create_order')
    ) {
      url = `${base}${statusPath}`
    }
  }
  const payload =
    apiStyle === 'aurax' ? { reference: oid, order_id: oid } : { order_id: oid }
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

export function verifyWebhookSignature(req, body, cred) {
  const secret = String(
    process.env.AURAXPAY_SIGNING_SECRET ||
      process.env.AURAXPAY_SECRET_KEY ||
      process.env.AURAXPAY_WEBHOOK_SECRET ||
      cred?.signingSecret ||
      '',
  ).trim()
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
    const row = await billing.getAuraxpayRow()
    const cred = resolveAuraxpayCredentials(row || {})
    if (!verifyWebhookSignature(req, body, cred)) {
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
      const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn({
        ...txn,
        status: 'completed',
        order_id: merchantOrderId,
      })
      if (!act.skipped && act.deviceId) {
        notifySubscriptionActivatedFromAct(act, merchantOrderId)
      }
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
    return { ok: false, message: 'Missing API key (admin or AURAXPAY_API_KEY).' }
  }
  const base = apiBase(cred)
  if (!base) {
    return { ok: false, message: 'API endpoint is required (admin or AURAXPAY_ENDPOINT).' }
  }
  const apiStyle = detectAuraxpayApiStyle(cred)
  const collectUrl = resolveAuraxpayCollectPostUrl(cred)
  const url = collectUrl || `${base}${collectPathForStyle(apiStyle, cred)}`
  const webhookUrl = String(cred.webhookUrl || process.env.AURAXPAY_WEBHOOK_URL || '').trim()
  const probeBody =
    apiStyle === 'trawx'
      ? {
          code: 101,
          merchant_order_id: `osm_probe_${Date.now()}`,
          amount: 1000,
          currency: 'TZS',
          merchant_webhook: webhookUrl,
          product_count: 1,
          customer_email: 'probe@osmani.tv',
          customer_name: 'Osmani Probe',
          customer_phone: '255700000000',
          customer_userid: cred.accountId || 'probe',
        }
      : {
          phone: '255700000000',
          amount: 1000,
          currency: 'TZS',
          reference: `osm_probe_${Date.now()}`,
          callback_url: webhookUrl,
          ...(cred.accountId ? { account_id: cred.accountId } : {}),
        }
  try {
    const res = await httpJson(url, {
      method: 'POST',
      headers: authHeaders(cred, apiStyle),
      body: probeBody,
    })
    const providerMessage = String(res.body?.message ?? res.body?.error ?? '').trim()
    const endpointMissing =
      res.status === 404 &&
      providerMessage.toLowerCase() === 'endpoint not found'
    if (endpointMissing) {
      return {
        ok: false,
        message: `Collect POST route not found (HTTP 404) at ${url}. Check API endpoint / AURAXPAY_COLLECT_URL.`,
        httpStatus: res.status,
        apiStyle,
        collectUrl: url,
        providerMessage,
      }
    }
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        message: `API key rejected (HTTP ${res.status}): ${providerMessage || 'Unauthorized'}. Collect URL: ${url}`,
        httpStatus: res.status,
        apiStyle,
        collectUrl: url,
        providerMessage,
      }
    }
    if (isCreateOrderAccepted(res, { apiStyle })) {
      return {
        ok: true,
        message: `Aurax Pay collect POST accepted (HTTP ${res.status}). USSD push should work. URL: ${url}`,
        httpStatus: res.status,
        apiStyle,
        collectUrl: url,
        providerMessage: providerMessage || null,
      }
    }
    return {
      ok: res.ok,
      message: res.ok
        ? `Collect POST reachable (HTTP ${res.status}). URL: ${url}`
        : `Collect POST returned HTTP ${res.status}: ${providerMessage || JSON.stringify(res.body).slice(0, 120)} (URL: ${url})`,
      httpStatus: res.status,
      apiStyle,
      collectUrl: url,
      providerMessage: providerMessage || null,
    }
  } catch (e) {
    return {
      ok: false,
      message: e?.name === 'AbortError' ? 'Request timed out' : String(e.message || e),
      httpStatus: 0,
      apiStyle,
      collectUrl: url,
    }
  }
}
