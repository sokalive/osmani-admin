/**
 * Unit tests: subscription verify must not return active:false on transient DB/pool failure.
 */
import { DbPressureError } from '../src/lib/verifyDbResilience.js'
import {
  buildSubscriptionVerifyUnavailableBody,
  isDbTimeoutOrPressureError,
  resolveVerifyErrorHttpOutcome,
  subscriptionVerifyUnavailableReason,
} from '../src/lib/verifyDbResilience.js'
import { PoolSaturatedError } from '../src/lib/poolSaturation.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

function assertNotFalseInactive(body, label) {
  assert(body?.active !== false, `${label}: must not return active:false`)
}

const pressureCases = [
  ['DbPressureError slot wait', new DbPressureError('verify_db_slot_wait_exceeded')],
  ['PoolSaturatedError', new PoolSaturatedError('pool_saturated')],
  ['pool_acquire_timeout', new Error('pool_acquire_timeout after 2500ms')],
  ['query_timeout', new Error('query_timeout after 8000ms')],
  ['connection timeout', new Error('timeout exceeded when trying to connect')],
  ['too many clients', new Error('sorry, too many clients already')],
  ['connection reset', Object.assign(new Error('Connection reset'), { code: 'ECONNRESET' })],
]

for (const [label, err] of pressureCases) {
  assert(isDbTimeoutOrPressureError(err), `${label}: should classify as pressure`)
  const body = buildSubscriptionVerifyUnavailableBody(err)
  assert(body.retryable === true, `${label}: retryable`)
  assert(body.active === null, `${label}: active null`)
  assertNotFalseInactive(body, label)
  const outcome = resolveVerifyErrorHttpOutcome(err, null)
  assert(outcome.status === 503, `${label}: HTTP 503`)
  assert(outcome.retryable === true, `${label}: outcome retryable`)
  assertNotFalseInactive(outcome.body, `${label} outcome`)
}

// Last-resort active body wins over retryable failure
{
  const err = new DbPressureError('verify_db_slot_wait_exceeded')
  const activeBody = { active: true, status: 'active', playbackAllowed: true }
  const outcome = resolveVerifyErrorHttpOutcome(err, activeBody)
  assert(outcome.status === 200, 'cache-active: HTTP 200')
  assert(outcome.body.active === true, 'cache-active: preserves active:true')
}

// Non-pressure errors → 500, not active:false
{
  const err = new Error('unexpected_logic_bug')
  assert(!isDbTimeoutOrPressureError(err), 'non-pressure not classified as pressure')
  const outcome = resolveVerifyErrorHttpOutcome(err, null)
  assert(outcome.status === 500, 'non-pressure: HTTP 500')
  assert(outcome.body.retryable === false, 'non-pressure: not retryable')
  assertNotFalseInactive(outcome.body, 'non-pressure')
}

// Reason mapping
{
  assert(
    subscriptionVerifyUnavailableReason(new PoolSaturatedError('pool_saturated')) === 'pool_saturated',
    'reason pool_saturated',
  )
  assert(
    subscriptionVerifyUnavailableReason(new Error('verify_db_slot_wait_exceeded')) ===
      'verify_db_slot_wait_exceeded',
    'reason slot wait',
  )
}

console.log(`PASS subscription-verify-unavailable (${pressureCases.length + 3} cases)`)
