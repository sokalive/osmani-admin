/**
 * Await SonicPesa create-order before the HTTP response.
 * A local order id is not proof that a PIN prompt was dispatched.
 */
import { createHash, randomBytes } from 'node:crypto'
import { getPool } from '../db/pool.js'
import * as billing from '../billingStore.js'
import { liveSyncBus } from './liveSyncBus.js'
import { schedulePostPaymentActivationPolls } from './paymentActivationBoost.js'
import { enqueueSonicpesaPaymentReconciliation } from './sonicpesaPaymentReconciliationQueue.js'
import { createOrder } from './payments/providers/sonicpesa.js'
import {
  classifySonicpesaCreateResult,
  decideDuplicateCheckout,
  redactPaymentBody,
  shouldActivelyReconcile,
} from './sonicpesaCheckoutPolicy.js'
import { withSonicpesaCreateSlot } from './sonicpesaCreateConcurrency.js'
import { noteCheckoutMetric } from './sonicpesaCheckoutMetrics.js'

function deviceCheckoutLockKey(deviceId) {
  const buf = createHash('sha256').update(`osmani-sonicpesa-checkout:${deviceId}`).digest()
  const n = buf.readInt32BE(0)
  return n === 0 ? 1 : n
}

async function withDeviceCheckoutLock(deviceId, fn) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  const client = await pool.connect()
  const key = deviceCheckoutLockKey(deviceId)
  const t0 = Date.now()
  try {
    await client.query('SELECT pg_advisory_lock($1::bigint)', [key])
    const lockMs = Date.now() - t0
    return await fn({ lockMs })
  } finally {
    let unlockError = null
    try {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [key])
    } catch (e) {
      unlockError = e
    }
    client.release(unlockError || undefined)
  }
}

async function listRecentCheckouts(deviceId) {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT order_id, status, external_id, device_id, created_at, updated_at, raw_payload
     FROM transactions
     WHERE device_id = $1
       AND COALESCE(raw_payload->>'payment_provider', '') = 'sonicpesa'
       AND created_at > now() - interval '10 minutes'
     ORDER BY created_at DESC
     LIMIT 5`,
    [deviceId],
  )
  return rows.map((row) => {
    const raw = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}
    return {
      order_id: row.order_id,
      status: row.status,
      external_id: row.external_id,
      device_id: row.device_id,
      created_at: row.created_at,
      updated_at: row.updated_at,
      provider_initiation: raw.provider_initiation ?? null,
      checkout_phase: raw.checkout_phase ?? null,
      provider_order_id: raw.provider_order_id ?? null,
      httpStatus: raw.httpStatus ?? null,
      fingerprint_hash: raw.fingerprint_hash ?? null,
      raw_payload: raw,
    }
  })
}

function identityMatches(row, deviceId, fingerprintHash) {
  if (String(row.device_id ?? '') !== String(deviceId)) return false
  const stored = String(row.fingerprint_hash ?? '').trim()
  if (stored && fingerprintHash && stored !== fingerprintHash) return false
  return true
}

function httpForKind(kind) {
  if (kind === 'accepted') return 201
  if (kind === 'retryable_rejection' || kind === 'capacity') return 429
  if (kind === 'ambiguous' || kind === 'block_ambiguous' || kind === 'block_in_flight') return 409
  return 502
}

/**
 * @param {import('express').Response} res
 */
function sendCheckout(res, status, body) {
  if (body.retry_after_seconds != null) {
    res.set('Retry-After', String(body.retry_after_seconds))
  }
  res.status(status).json(body)
}

export async function runAwaitedSonicpesaCreateOrder({
  res,
  deviceId,
  phone,
  phoneE164,
  plan,
  planId,
  cred,
  fingerprintPayload,
  correlationId,
  timings,
}) {
  const fingerprintHash = fingerprintPayload.fingerprint_hash
    ? String(fingerprintPayload.fingerprint_hash)
    : ''
  const locked = await withDeviceCheckoutLock(deviceId, async ({ lockMs }) => {
    timings.lockMs = lockMs
    const recent = await listRecentCheckouts(deviceId)
    const owned = recent.filter((row) => String(row.device_id) === String(deviceId))
    const dup = decideDuplicateCheckout(owned, Date.now())
    if (dup.action === 'reuse_accepted') {
      const row = owned.find((r) => r.order_id === dup.orderId)
      if (!row || !identityMatches(row, deviceId, fingerprintHash)) {
        return { action: 'identity_mismatch' }
      }
      return { action: 'reuse_accepted', row, providerOrderId: dup.providerOrderId }
    }
    if (dup.action !== 'create') return { action: dup.action, dup }

    const slotted = await withSonicpesaCreateSlot(async () => {
      const orderId = `osm_sp_${Date.now()}_${randomBytes(5).toString('hex')}`
      const amount = Number(plan.price)
      const basePayload = {
        step: 'created',
        payment_provider: 'sonicpesa',
        phoneNorm: phone,
        device_id: deviceId,
        correlation_id: correlationId,
        provider_initiation: 'provider_pending',
        checkout_phase: 'provider_pending',
        pin_wait_allowed: false,
        ...fingerprintPayload,
      }
      const tInsert = Date.now()
      const tx = await billing.insertTransaction({
        order_id: orderId,
        plan_id: planId,
        phone: phoneE164,
        amount,
        currency: 'TZS',
        status: 'pending',
        device_id: deviceId,
        plan_duration_days: plan.duration_days,
        raw_payload: basePayload,
      })
      timings.insertMs = Date.now() - tInsert
      liveSyncBus.publish('analytics.transaction_updated', {
        topics: ['analytics'],
        orderId,
        status: 'pending',
        deviceId,
      })
      const tProvider = Date.now()
      let result
      try {
        result = await createOrder(cred, { phone, amount, orderId, currency: 'TZS' })
      } catch (e) {
        result = { ok: false, status: 0, body: { error: 'provider_request_failed' } }
        console.warn('[sonicpesa] createOrder threw', { correlationId, orderId, name: e?.name || 'Error' })
      }
      timings.providerMs = Date.now() - tProvider
      const classified = classifySonicpesaCreateResult(result)
      const prev = tx.raw_payload && typeof tx.raw_payload === 'object' ? tx.raw_payload : basePayload
      const nextPayload = {
        ...prev,
        sonicpesa: redactPaymentBody(result.body),
        provider_order_id: classified.providerOrderId,
        httpStatus: classified.httpStatus,
        provider_initiation_ms: timings.providerMs,
        provider_initiation: classified.providerInitiation,
        checkout_phase: classified.checkoutPhase,
        pin_wait_allowed: classified.pinWaitAllowed,
        skip_provider_poll: classified.kind === 'ambiguous' && !classified.providerOrderId,
        correlation_id: correlationId,
        create_timings: { ...timings },
      }
      await billing.updateTransactionByOrderId(orderId, {
        status: classified.txnStatus,
        external_id: classified.providerOrderId,
        raw_payload: nextPayload,
      })
      liveSyncBus.publish('analytics.transaction_updated', {
        topics: ['analytics'],
        orderId,
        status: classified.txnStatus,
        deviceId,
      })
      if (classified.enqueueReconcile && shouldActivelyReconcile({
        status: classified.txnStatus,
        external_id: classified.providerOrderId,
        raw_payload: nextPayload,
      })) {
        schedulePostPaymentActivationPolls(orderId, deviceId)
        await enqueueSonicpesaPaymentReconciliation(orderId, deviceId, { priority: 2 }).catch((e) => {
          console.warn('[sonicpesa] reconcile enqueue failed', orderId, e?.message || e)
        })
      }
      return { action: 'created', orderId, tx, amount, classified }
    })
    if (!slotted.ok) return { action: 'capacity' }
    return slotted.value
  })

  if (locked.action === 'reuse_accepted') {
    noteCheckoutMetric('deduped')
    const row = locked.row
    sendCheckout(res, 201, {
      ok: true,
      provider: 'sonicpesa',
      reused: true,
      orderId: row.order_id,
      provider_order_id: locked.providerOrderId,
      provider_initiation: 'accepted',
      checkout_phase: 'awaiting_authorization',
      pin_wait_allowed: true,
      deviceId,
      amount: Number(plan.price),
      currency: 'TZS',
      correlation_id: correlationId,
    })
    return
  }

  if (locked.action === 'block_429') {
    noteCheckoutMetric('deduped')
    const retryAfterSeconds = Math.max(1, Math.ceil(Number(locked.dup?.retryAfterMs || 60_000) / 1000))
    sendCheckout(res, 429, {
      ok: false,
      error: 'Maombi mengi sana. Subiri kidogo kisha ujaribu tena.',
      provider: 'sonicpesa',
      provider_initiation: 'rejected_retryable',
      checkout_phase: 'retryable_rejection',
      pin_wait_allowed: false,
      retryable: true,
      retry_after_seconds: retryAfterSeconds,
      correlation_id: correlationId,
    })
    return
  }

  if (locked.action === 'block_ambiguous' || locked.action === 'block_in_flight') {
    noteCheckoutMetric('deduped')
    sendCheckout(res, 409, {
      ok: false,
      error: 'Hatujapata jibu la malipo. Subiri kidogo usijaribu mara mbili.',
      provider: 'sonicpesa',
      provider_initiation: 'ambiguous',
      checkout_phase: 'ambiguous',
      pin_wait_allowed: false,
      retryable: false,
      correlation_id: correlationId,
    })
    return
  }

  if (locked.action === 'identity_mismatch') {
    sendCheckout(res, 403, {
      ok: false,
      error: 'Imeshindwa kuthibitisha kifaa kwa oda hii.',
      provider: 'sonicpesa',
      pin_wait_allowed: false,
      correlation_id: correlationId,
    })
    return
  }

  if (locked.action === 'capacity') {
    sendCheckout(res, 429, {
      ok: false,
      error: 'Maombi mengi sana. Subiri kidogo kisha ujaribu tena.',
      provider: 'sonicpesa',
      provider_initiation: 'capacity_exhausted',
      checkout_phase: 'capacity_exhausted',
      pin_wait_allowed: false,
      retryable: true,
      retry_after_seconds: 15,
      correlation_id: correlationId,
    })
    return
  }

  const { orderId, tx, amount, classified } = locked
  if (classified.kind === 'accepted') noteCheckoutMetric('accepted', { providerMs: timings.providerMs })
  else if (classified.kind === 'retryable_rejection') noteCheckoutMetric('http_429', { providerMs: timings.providerMs })
  else if (classified.kind === 'ambiguous') noteCheckoutMetric('ambiguous', { providerMs: timings.providerMs })
  else noteCheckoutMetric('terminal_rejection', { providerMs: timings.providerMs })

  console.log('[sonicpesa] create-order result', {
    correlationId,
    orderId,
    checkoutPhase: classified.checkoutPhase,
    httpStatus: classified.httpStatus,
    providerMs: timings.providerMs,
    pinWaitAllowed: classified.pinWaitAllowed === true,
  })

  if (classified.kind === 'accepted') {
    sendCheckout(res, 201, {
      ok: true,
      provider: 'sonicpesa',
      orderId,
      provider_order_id: classified.providerOrderId,
      provider_initiation: 'accepted',
      checkout_phase: 'awaiting_authorization',
      pin_wait_allowed: true,
      deviceId,
      transactionId: tx.id,
      amount,
      currency: 'TZS',
      correlation_id: correlationId,
    })
    return
  }

  const status = httpForKind(classified.kind)
  sendCheckout(res, status, {
    ok: false,
    error: classified.userMessage,
    provider: 'sonicpesa',
    orderId,
    provider_initiation: classified.providerInitiation,
    checkout_phase: classified.checkoutPhase,
    pin_wait_allowed: false,
    retryable: classified.retryable === true,
    retry_after_seconds:
      classified.retryAfterMs != null ? Math.max(1, Math.ceil(classified.retryAfterMs / 1000)) : undefined,
    correlation_id: correlationId,
  })
}
