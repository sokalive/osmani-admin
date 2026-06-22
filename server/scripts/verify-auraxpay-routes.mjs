/**
 * Aurax Pay route + provider wiring verification (static + optional live HTTP).
 *
 * Usage:
 *   node scripts/verify-auraxpay-routes.mjs
 *   BASE_URL=https://api.osmanitv.com node scripts/verify-auraxpay-routes.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  detectAuraxpayApiStyle,
  normalizeAuraxpayApiEndpoint,
  normalizeAuraxpayCollectUrl,
  listAuraxNativeCollectCandidateUrls,
  resolveAuraxpayCollectPostUrl,
} from '../src/lib/payments/providers/auraxpay.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')
const BASE_URL = String(process.env.BASE_URL || process.env.VPS_API || 'https://api.osmanitv.com').replace(
  /\/$/,
  '',
)
const LIVE = String(process.env.VERIFY_LIVE ?? '1').trim() !== '0'

function read(rel) {
  return readFileSync(path.join(src, rel), 'utf8')
}

const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

const payments = read('routes/payments.js')
const webhooks = read('routes/webhooks.js')
const restApi = read('routes/restApi.js')
const auraxpayPayments = read('routes/auraxpayPayments.js')

assert(
  'create-payment routes auraxpay when checkout provider is auraxpay',
  payments.includes("checkout.payment_provider === 'auraxpay'") &&
    payments.includes('handleAuraxpayCreateOrder'),
)
assert(
  'webhook alias POST /webhooks/aurax',
  webhooks.includes("webhooksRouter.post('/aurax'") && webhooks.includes('handleAuraxPayWebhook'),
)
assert(
  'public auraxpay payment routes registered',
  restApi.includes('/payments/auraxpay/create-order') &&
    restApi.includes('/payments/auraxpay/webhook') &&
    restApi.includes('/webhooks/aurax'),
)
assert(
  'auraxpay create-order handler exported',
  auraxpayPayments.includes('export async function handleAuraxpayCreateOrder'),
)
assert(
  'activation polls scheduled on aurax success',
  auraxpayPayments.includes('schedulePostPaymentActivationPolls'),
)

const cred = { apiEndpoint: 'https://api.auraxpay.net/v1', apiKey: 'test' }
assert(
  'native collect URL',
  detectAuraxpayApiStyle(cred) === 'aurax' &&
    resolveAuraxpayCollectPostUrl(cred) === 'https://api.auraxpay.net/v1/payments/collect',
  resolveAuraxpayCollectPostUrl(cred),
)
assert(
  'native fallback URLs',
  (() => {
    const urls = listAuraxNativeCollectCandidateUrls(cred)
    return (
      urls.length === 2 &&
      urls[0] === 'https://api.auraxpay.net/v1/payments/collect' &&
      urls[1] === 'https://api.auraxpay.net/v1/payments/create-order'
    )
  })(),
)
assert(
  'normalize strips wrong .com host path and adds /v1',
  normalizeAuraxpayApiEndpoint('https://api.auraxpay.net') === 'https://api.auraxpay.net/v1',
)
assert(
  'legacy AURAXPAY_COLLECT_PATH=/payment/create_order ignored on native host',
  (() => {
    const prev = process.env.AURAXPAY_COLLECT_PATH
    process.env.AURAXPAY_COLLECT_PATH = '/payment/create_order'
    const out =
      resolveAuraxpayCollectPostUrl({ apiEndpoint: 'https://api.auraxpay.net/v1', apiKey: 'x' }) ===
      'https://api.auraxpay.net/v1/payments/collect'
    if (prev === undefined) delete process.env.AURAXPAY_COLLECT_PATH
    else process.env.AURAXPAY_COLLECT_PATH = prev
    return out
  })(),
)
assert(
  'normalize collect URL missing /v1',
  normalizeAuraxpayCollectUrl('https://api.auraxpay.net/payments/collect') ===
    'https://api.auraxpay.net/v1/payments/collect',
)

async function liveCheck(name, fn) {
  try {
    await fn()
    assert(`live: ${name}`, true)
  } catch (e) {
    assert(`live: ${name}`, false, String(e.message || e))
  }
}

async function fetchStatus(method, urlPath, body) {
  const res = await fetch(`${BASE_URL}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  return res.status
}

if (LIVE) {
  await liveCheck('GET /api/payments/checkout-providers', async () => {
    const res = await fetch(`${BASE_URL}/api/payments/checkout-providers`, { cache: 'no-store' })
    const body = await res.json()
    if (!res.ok || body?.ok !== true) throw new Error(`HTTP ${res.status}`)
    if (!('auraxpay' in body) || !('auraxpay_test' in body) || !('payment_provider' in body)) {
      throw new Error('missing auraxpay provider fields')
    }
  })

  await liveCheck('POST /api/webhooks/aurax not 404', async () => {
    const status = await fetchStatus('POST', '/api/webhooks/aurax', {})
    if (status === 404) throw new Error('endpoint not found (404)')
  })

  await liveCheck('POST /api/payments/auraxpay/webhook not 404', async () => {
    const status = await fetchStatus('POST', '/api/payments/auraxpay/webhook', {})
    if (status === 404) throw new Error('endpoint not found (404)')
  })

  await liveCheck('POST /api/payments/auraxpay/create-order registered', async () => {
    const status = await fetchStatus('POST', '/api/payments/auraxpay/create-order', {})
    if (status === 404) throw new Error('endpoint not found (404)')
  })

  await liveCheck('POST /api/payments/create-payment registered', async () => {
    const status = await fetchStatus('POST', '/api/payments/create-payment', {})
    if (status === 404) throw new Error('endpoint not found (404)')
  })
}

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(c.ok ? 'OK' : 'FAIL', c.name, c.detail ? `— ${c.detail}` : '')
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}

console.log(`\nAll Aurax Pay route checks passed${LIVE ? ` (live: ${BASE_URL})` : ' (static only)'}.`)
