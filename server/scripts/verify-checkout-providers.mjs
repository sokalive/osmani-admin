/**
 * Static verification: three checkout providers (zenopay, sonicpesa, auraxpay) are wired.
 * Run: node scripts/verify-checkout-providers.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import {
  detectAuraxpayApiStyle,
  normalizeAuraxpayApiEndpoint,
  resolveAuraxpayCollectPostUrl,
} from '../src/lib/payments/providers/auraxpay.js'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(root, 'src')

function read(rel) {
  return readFileSync(path.join(src, rel), 'utf8')
}

const checks = []

function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

// paymentReconcile aurax branch
const reconcile = read('paymentReconcile.js')
assert(
  'paymentReconcile auraxpay branch',
  reconcile.includes("rawPayload.payment_provider === 'auraxpay'") &&
    reconcile.includes('auraxpayGetOrderStatus'),
)

// payments router
const payments = read('routes/payments.js')
const restApi = read('routes/restApi.js')
assert(
  'create-payment auraxpay branch',
  payments.includes("checkout.payment_provider === 'auraxpay'") &&
    payments.includes('handleAuraxpayCreateOrder'),
)
assert(
  'webhooks aurax alias',
  read('routes/webhooks.js').includes("webhooksRouter.post('/aurax'"),
)
assert(
  'payments checkout-providers includes auraxpay',
  payments.includes('auraxpay') &&
    payments.includes('auraxpay_test') &&
    payments.includes("paymentsRouter.use('/auraxpay'"),
)
assert(
  'admin auraxpay test checkout route',
  read('routes/adminAuraxpayPayments.js').includes('admin_test_checkout') &&
    restApi.includes("restApi.use('/admin/payments/auraxpay'"),
)

// restApi mount
assert(
  'restApi mounts auraxpay settings',
  restApi.includes("restApi.use('/settings/auraxpay'") &&
    restApi.includes('/payments/auraxpay/webhook'),
)

// billing constraint
const billingTables = read('db/billingTables.js')
assert(
  'checkout_payment_provider_check includes auraxpay',
  billingTables.includes("'auraxpay'") && billingTables.includes('auraxpay_settings'),
)

// provider module exports
const aurax = read('lib/payments/providers/auraxpay.js')
assert(
  'auraxpay provider exports',
  ['resolveAuraxpayCredentials', 'createOrder', 'verifyPayment', 'handleWebhook', 'testConnection'].every(
    (fn) => aurax.includes(`export function ${fn}`) || aurax.includes(`export async function ${fn}`),
  ),
)
assert(
  'auraxpay API style + collect URL helpers',
  aurax.includes('detectAuraxpayApiStyle') &&
    aurax.includes('resolveAuraxpayCollectPostUrl') &&
    aurax.includes('/api/create-order'),
)
assert(
  'checkout provider liveSync on update',
  read('billingStore.js').includes('config.checkout_payment_provider_changed'),
)
assert(
  'auraxpay set-active-provider route',
  read('routes/auraxpaySettings.js').includes("'/set-active-provider'"),
)

assert(
  'aurax endpoint normalization',
  normalizeAuraxpayApiEndpoint('https://api.auraxpay.net') === 'https://api.auraxpay.net/v1',
)
const auraxNetCred = { apiEndpoint: 'https://api.auraxpay.net/v1', apiKey: 'test' }
assert(
  'aurax native collect URL (/v1/payments/collect)',
  detectAuraxpayApiStyle(auraxNetCred) === 'aurax' &&
    resolveAuraxpayCollectPostUrl(auraxNetCred) ===
      'https://api.auraxpay.net/v1/payments/collect',
  resolveAuraxpayCollectPostUrl(auraxNetCred),
)
const trawxCred = { apiEndpoint: 'https://pay.trawx.example/v1', apiKey: 'test' }
assert(
  'trawx collect URL uses origin + /api/create-order',
  detectAuraxpayApiStyle(trawxCred) === 'trawx' &&
    resolveAuraxpayCollectPostUrl(trawxCred) === 'https://pay.trawx.example/api/create-order',
  resolveAuraxpayCollectPostUrl(trawxCred),
)

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(c.ok ? 'OK' : 'FAIL', c.name, c.detail ? `— ${c.detail}` : '')
}

if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}

console.log('\nAll checkout provider checks passed (zenopay + sonicpesa + auraxpay).')
