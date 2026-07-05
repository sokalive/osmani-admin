#!/usr/bin/env node
/**
 * SonicPesa payment reliability engineering tests (no real charges).
 * Run: node scripts/test-sonicpesa-payment-reliability.mjs
 */
import crypto from 'node:crypto'
import { verifyWebhookSignature, signWebhookPayload, normalizeResponse } from '../src/lib/payments/providers/sonicpesa.js'
import { hashWebhookPayload, INBOX_STATUS } from '../src/lib/sonicpesaWebhookInbox.js'
import {
  webhookOrderIdCandidates,
  sonicPaymentSucceeded,
  sonicExplicitFailure,
  isProviderCompletionEvent,
  webhookAmountMatchesTxn,
  extractWebhookTransId,
} from '../src/lib/sonicpesaWebhookHelpers.js'
import { ACTIVATION_STATE, COMPLETION_SOURCE } from '../src/lib/canonicalPaymentActivation.js'

const checks = []
function assert(name, ok, detail = '') {
  checks.push({ name, ok, detail })
}

// 1. Invalid signature
const secret = 'unit-test-secret'
const body = { order_id: 'osm_sp_test001', payment_status: 'SUCCESS', data: { payment_status: 'SUCCESS' } }
const sig = crypto.createHmac('sha256', secret).update(JSON.stringify(body), 'utf8').digest('hex')
const prevSecret = process.env.SONICPESA_WEBHOOK_SECRET
process.env.SONICPESA_WEBHOOK_SECRET = secret
assert('invalid signature rejected', verifyWebhookSignature({ headers: {} }, body) === false)
assert('valid signature accepted', verifyWebhookSignature({ headers: { 'x-sonicpesa-signature': sig } }, body) === true)
if (prevSecret === undefined) delete process.env.SONICPESA_WEBHOOK_SECRET
else process.env.SONICPESA_WEBHOOK_SECRET = prevSecret

// 2. Inbox payload hash stable
const h1 = hashWebhookPayload(body)
const h2 = hashWebhookPayload({ ...body })
assert('payload hash deterministic', h1 === h2 && h1.length === 64)

// 3. Order id extraction
const ids = webhookOrderIdCandidates({
  merchant_order_id: 'osm_sp_m1',
  data: { order_id: 'sp_provider_1' },
})
assert('webhook order candidates', ids.includes('osm_sp_m1') && ids.includes('sp_provider_1'), ids.join(','))

// 4. Payment status normalization
assert('success webhook', sonicPaymentSucceeded({ payment_status: 'SUCCESS' }) === true)
assert('failure webhook', sonicExplicitFailure({ payment_status: 'FAILED' }) === true)
assert('pending not success', sonicPaymentSucceeded({ payment_status: 'PENDING' }) === false)

// 4b. Owner dashboard payload schema (payment.completed + status SUCCESS + transid)
const ownerPayload = {
  event: 'payment.completed',
  order_id: 'sp_67890abcdef',
  amount: 10000,
  status: 'SUCCESS',
  transid: 'TXN123456',
}
const ownerNorm = normalizeResponse(ownerPayload)
assert('owner schema succeeded', ownerNorm.succeeded === true, ownerNorm.paymentStatus)
assert('owner schema transid', ownerNorm.transId === 'TXN123456')
assert('owner schema event', ownerNorm.eventType === 'payment.completed')
assert('owner completion event', isProviderCompletionEvent(ownerPayload) === true)
assert('non-completion event ignored', isProviderCompletionEvent({ event: 'payment.pending', status: 'PENDING' }) === false)
assert('owner transid extract', extractWebhookTransId(ownerPayload) === 'TXN123456')
assert(
  'amount match txn',
  webhookAmountMatchesTxn({ amount: 10000 }, ownerPayload) === true,
)
assert(
  'amount mismatch detected',
  webhookAmountMatchesTxn({ amount: 5000 }, ownerPayload) === false,
)

// 4c. Raw-body HMAC (provider signs exact POST bytes)
const rawJson = JSON.stringify(ownerPayload)
const rawSig = signWebhookPayload(secret, Buffer.from(rawJson, 'utf8'))
assert(
  'raw body signature',
  verifyWebhookSignature({ headers: { 'x-sonicpesa-signature': rawSig }, rawBody: Buffer.from(rawJson, 'utf8') }, ownerPayload) === true,
)

// 6. Canonical VPS webhook URL (never Render)
import {
  canonicalSonicpesaProductionWebhookUrl,
  isLegacyRenderWebhookUrl,
  normalizeStoredSonicpesaWebhookUrl,
} from '../src/lib/sonicpesaWebhookConfig.js'

assert(
  'canonical webhook is VPS',
  canonicalSonicpesaProductionWebhookUrl().includes('api.osmanitv.com'),
)
assert(
  'render webhook normalized',
  normalizeStoredSonicpesaWebhookUrl('https://osmani-admin-api.onrender.com/api/payments/sonicpesa/webhook').includes(
    'api.osmanitv.com',
  ),
)
assert(
  'legacy render detected',
  isLegacyRenderWebhookUrl('https://osmani-admin-api.onrender.com/api/payments/sonicpesa/webhook') === true,
)

// 7. Activation state constants
assert('activation states defined', Boolean(ACTIVATION_STATE.PHONE_CONFLICT && ACTIVATION_STATE.ACTIVATED))
assert('completion sources defined', COMPLETION_SOURCE.SONIC_WEBHOOK === 'sonic_webhook')

// 8. Inbox status enum
assert('inbox statuses', INBOX_STATUS.RECEIVED === 'RECEIVED' && INBOX_STATUS.PROCESSED === 'PROCESSED')

// Optional DB integration tests
async function runDbTests() {
  if (!process.env.DATABASE_URL) {
    console.log('SKIP DB tests — DATABASE_URL not set')
    return
  }
  const { getPool } = await import('../src/db/pool.js')
  const { ensureBillingStorage } = await import('../src/billingStore.js')
  const { insertSonicpesaWebhookInbox } = await import('../src/lib/sonicpesaWebhookInbox.js')
  await ensureBillingStorage()
  const pool = getPool()
  const testBody = {
    order_id: `inbox_test_${Date.now()}`,
    payment_status: 'PENDING',
    test_fixture: true,
  }
  const a = await insertSonicpesaWebhookInbox({ payload: testBody, signatureVerified: true })
  const b = await insertSonicpesaWebhookInbox({ payload: testBody, signatureVerified: true })
  assert('inbox dedupe duplicate', a.duplicate === false && b.duplicate === true)
  await pool.query(`DELETE FROM sonicpesa_webhook_inbox WHERE id = ANY($1::bigint[])`, [
    [a.id, b.id].filter(Boolean),
  ])
}

await runDbTests()

const failed = checks.filter((c) => !c.ok)
for (const c of checks) {
  console.log(c.ok ? 'OK' : 'FAIL', c.name, c.detail ? `— ${c.detail}` : '')
}
if (failed.length) {
  console.error(`\n${failed.length} check(s) failed`)
  process.exit(1)
}
console.log(`\nAll ${checks.length} SonicPesa reliability checks passed.`)
