/**
 * AuraxPay integration unit checks (no live payment / no secrets required).
 * Run: node scripts/test-auraxpay-integration.mjs
 */
import crypto from 'node:crypto'
import {
  detectAuraxpayApiStyle,
  listAuraxNativeCollectCandidateUrls,
  normalizeAuraxpayAccountId,
  normalizeAuraxpayApiEndpoint,
  resolveAuraxpayCollectPostUrl,
  resolveAuraxpayCredentials,
  verifyWebhookSignature,
} from '../src/lib/payments/providers/auraxpay.js'

const cred = {
  apiEndpoint: 'https://api.auraxpay.net/v1',
  apiKey: 'test',
  accountId: '0676809174',
  webhookUrl: 'https://api.osmanitv.com/api/payments/auraxpay/webhook',
}

const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

assert('apiStyle native aurax', detectAuraxpayApiStyle(cred) === 'aurax')
assert(
  'collect URL',
  resolveAuraxpayCollectPostUrl(cred) === 'https://api.auraxpay.net/v1/payments/collect',
  resolveAuraxpayCollectPostUrl(cred),
)
assert(
  'endpoint normalize adds /v1',
  normalizeAuraxpayApiEndpoint('https://api.auraxpay.net') === 'https://api.auraxpay.net/v1',
)
assert(
  'account id from local 0-prefix',
  normalizeAuraxpayAccountId('0676809174') === '255676809174',
  normalizeAuraxpayAccountId('0676809174'),
)
assert(
  'account id keeps 255-prefix',
  normalizeAuraxpayAccountId('255676809174') === '255676809174',
)
const resolved = resolveAuraxpayCredentials({ account_id: '255676809174', api_endpoint: cred.apiEndpoint })
assert('credentials account normalized', resolved.accountId === '255676809174')

const candidates = listAuraxNativeCollectCandidateUrls(cred)
assert(
  'native collect candidates include collect + create-order fallback',
  candidates.length === 2 &&
    candidates[0].endsWith('/payments/collect') &&
    candidates[1].endsWith('/payments/create-order'),
  candidates.join(', '),
)

const prevCollect = process.env.AURAXPAY_COLLECT_URL
process.env.AURAXPAY_COLLECT_URL = 'https://api.auraxpay.net/v1/payments/create-order'
assert(
  'legacy AURAXPAY_COLLECT_URL ignored on native host',
  resolveAuraxpayCollectPostUrl(cred) === 'https://api.auraxpay.net/v1/payments/collect',
)
if (prevCollect === undefined) delete process.env.AURAXPAY_COLLECT_URL
else process.env.AURAXPAY_COLLECT_URL = prevCollect

const secret = 'test-webhook-secret'
const body = { reference: 'osm_ax_test', status: 'completed', payment_status: 'COMPLETED' }
const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(body), 'utf8').digest('hex')
const req = { headers: { 'x-auraxpay-signature': sig } }
assert(
  'webhook signature valid',
  verifyWebhookSignature(req, body, { signingSecret: secret }) === true,
)
assert(
  'webhook signature rejects missing header',
  verifyWebhookSignature({ headers: {} }, body, { signingSecret: secret }) === false,
)
assert(
  'webhook signature skips when no secret',
  verifyWebhookSignature({ headers: {} }, body, { signingSecret: '' }) === true,
)

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(c.ok ? 'OK' : 'FAIL', c.name, c.detail ? `— ${c.detail}` : '')
}
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${checks.length} AuraxPay integration checks passed.`)
