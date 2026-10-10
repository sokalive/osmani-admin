/**
 * SonicPesa checkout reliability. Mocks only — no network, no database writes.
 * Run: node scripts/verify-sonicpesa-checkout-reliability.mjs
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  CHECKOUT_PHASE,
  checkoutAllowsEntitlement,
  classifySonicpesaCreateResult,
  decideDuplicateCheckout,
  pinWaitAllowedFromTxn,
  redactPaymentBody,
  shouldActivelyReconcile,
  sonicpesaCheckoutLimits,
} from '../src/lib/sonicpesaCheckoutPolicy.js'
import { deriveAppWaitingState } from '../src/lib/paymentAppWaitingState.js'

const root = dirname(fileURLToPath(import.meta.url))
let failed = 0

function assert(name, cond) {
  if (cond) console.log('PASS', name)
  else {
    failed += 1
    console.error('FAIL', name)
  }
}

const accepted = classifySonicpesaCreateResult({
  ok: true,
  status: 200,
  body: { status: 'success', data: { order_id: 'sp_ok_1' } },
  normalized: { providerOrderId: 'sp_ok_1' },
})
assert('accepted has provider reference and PIN wait', accepted.kind === 'accepted' && accepted.pinWaitAllowed === true && accepted.providerOrderId === 'sp_ok_1' && accepted.enqueueReconcile === true)
assert('local pending row is not PIN wait', pinWaitAllowedFromTxn({ status: 'pending', raw_payload: { provider_initiation: 'pending' } }) === false)
assert('HTTP 201 shape is not implied by a pending initiation', accepted.checkoutPhase === CHECKOUT_PHASE.AWAITING_AUTHORIZATION)

const limited = classifySonicpesaCreateResult({
  ok: false,
  status: 429,
  retryAfter: '30',
  body: { message: 'Too Many Attempts.' },
})
assert('429 is retryable rejection', limited.kind === 'retryable_rejection' && limited.pinWaitAllowed === false && limited.txnStatus === 'failed' && limited.enqueueReconcile === false)
assert('429 honors Retry-After', limited.retryAfterMs === 30_000)
assert('429 waiting state does not allow PIN', deriveAppWaitingState({
  txn: {
    status: 'failed',
    raw_payload: { httpStatus: 429, provider_initiation: 'rejected_retryable', checkout_phase: 'retryable_rejection' },
  },
}).pin_wait_allowed === false && deriveAppWaitingState({
  txn: {
    status: 'failed',
    raw_payload: { httpStatus: 429, provider_initiation: 'rejected_retryable' },
  },
}).entitlement_active === false)

const timeout = classifySonicpesaCreateResult({
  ok: false,
  status: 0,
  body: { error: 'This operation was aborted' },
})
assert('timeout is ambiguous and not a new charge signal', timeout.kind === 'ambiguous' && timeout.pinWaitAllowed === false && timeout.txnStatus === 'pending' && timeout.enqueueReconcile === false)
assert('ambiguous without provider id is not polled', shouldActivelyReconcile({
  status: 'pending',
  raw_payload: { payment_provider: 'sonicpesa', provider_initiation: 'ambiguous', skip_provider_poll: true },
}) === false)

const now = Date.now()
const dup = decideDuplicateCheckout([
  {
    order_id: 'osm_sp_a',
    status: 'pending',
    provider_initiation: 'accepted',
    provider_order_id: 'sp_ok_1',
    device_id: 'dev-1',
    updated_at: new Date(now - 1000).toISOString(),
  },
  {
    order_id: 'osm_sp_b',
    status: 'pending',
    provider_initiation: 'accepted',
    provider_order_id: 'sp_ok_2',
    device_id: 'dev-1',
    updated_at: new Date(now - 2000).toISOString(),
  },
], now)
assert('concurrent repeats reuse the accepted checkout', dup.action === 'reuse_accepted' && dup.orderId === 'osm_sp_a')

const blocked = decideDuplicateCheckout([
  {
    order_id: 'osm_sp_timeout',
    status: 'pending',
    provider_initiation: 'ambiguous',
    updated_at: new Date(now - 5000).toISOString(),
  },
], now)
assert('ambiguous checkout blocks another provider request', blocked.action === 'block_ambiguous')

const cooled = decideDuplicateCheckout([
  {
    order_id: 'osm_sp_429',
    status: 'failed',
    provider_initiation: 'rejected_retryable',
    httpStatus: 429,
    updated_at: new Date(now - 120_000).toISOString(),
  },
], now, { ...sonicpesaCheckoutLimits(), retry429Ms: 60_000, dedupMs: 180_000, ambiguousHoldMs: 180_000 })
assert('429 can be retried only after the cooldown', cooled.action === 'create')

const limits = sonicpesaCheckoutLimits()
assert('concurrency and queue wait are bounded', limits.maxConcurrent >= 1 && limits.maxConcurrent <= 8 && limits.queueWaitMs <= 20_000 && limits.retry429Ms <= 300_000)

assert('rejected order is not actively reconciled', shouldActivelyReconcile({
  status: 'failed',
  raw_payload: { provider_initiation: 'rejected_retryable', httpStatus: 429 },
}) === false)
assert('accepted pending order is still reconciled', shouldActivelyReconcile({
  status: 'pending',
  external_id: 'sp_ok_1',
  raw_payload: { payment_provider: 'sonicpesa', provider_initiation: 'accepted', provider_order_id: 'sp_ok_1' },
}) === true)

assert('failed checkout cannot grant entitlement', checkoutAllowsEntitlement({
  status: 'failed',
  raw_payload: { checkout_phase: 'retryable_rejection', provider_initiation: 'rejected_retryable' },
}) === false)
assert('historical completed checkout can still grant entitlement', checkoutAllowsEntitlement({
  status: 'completed',
  raw_payload: { payment_provider: 'sonicpesa', provider_initiation: 'accepted' },
}) === true)
assert('rejection marker cannot grant entitlement even if status were completed', checkoutAllowsEntitlement({
  status: 'completed',
  raw_payload: { checkout_phase: 'retryable_rejection', provider_initiation: 'rejected_retryable' },
}) === false)

const redacted = redactPaymentBody({
  buyer_phone: '255678000000',
  message: 'Too Many Attempts.',
  nested: { api_key: 'secret', order_id: 'sp_ok_1' },
})
assert('phone and secrets are redacted', redacted.buyer_phone === '[redacted]' && redacted.nested.api_key === '[redacted]' && redacted.nested.order_id === 'sp_ok_1' && !JSON.stringify(redacted).includes('255678000000'))

const activation = readFileSync(join(root, '../src/lib/canonicalPaymentActivation.js'), 'utf8')
assert('failed transactions are not resurrected by callbacks', activation.includes("if (txn.status === 'failed')"))
assert('duplicate completion uses the idempotent activation path', activation.includes('ALREADY_APPLIED') && activation.includes('checkoutAllowsEntitlement'))

const route = readFileSync(join(root, '../src/routes/sonicpesaPayments.js'), 'utf8')
assert('create-order waits for the provider result', route.includes('runAwaitedSonicpesaCreateOrder') && !route.includes('respondCreateOrderAccepted'))
const queue = readFileSync(join(root, '../src/lib/sonicpesaPaymentReconciliationQueue.js'), 'utf8')
assert('definitive rejections leave the active queue', queue.includes('sweepDefinitiveRejectionQueueRows') && queue.includes("TERMINAL_FAILED"))
const reconcile = readFileSync(join(root, '../src/paymentReconcile.js'), 'utf8')
assert('reconcile does not poll a merchant id as a provider id', reconcile.includes('shouldActivelyReconcile') && !reconcile.includes('txn.external_id ?? oid'))

if (failed) {
  console.error(`\n${failed} failed`)
  process.exit(1)
}
console.log('\nverify-sonicpesa-checkout-reliability ok')
