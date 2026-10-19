import { createHash } from 'node:crypto'

/**
 * SonicPesa checkout decisions that do not touch the network.
 *
 * Evidence (2026-10-10 16:14 UTC, order osm_sp_1791648883045_2281646b1a):
 * HTTP 429 "Too Many Attempts." in 765ms, no data.order_id. That is a
 * definitive retryable rejection, not proof a PIN prompt was sent.
 * HTTP 201 before the provider returns must not open the PIN countdown.
 */

/** Customer-initiated SonicPesa create-order attempts, then a fixed cooldown. */
export const SONICPESA_PAY_ATTEMPT_MAX = 3
export const SONICPESA_PAY_ATTEMPT_COOLDOWN_MS = 180_000
export const SONICPESA_PAY_ATTEMPT_COOLDOWN_CODE = 'SONICPESA_PAY_ATTEMPT_COOLDOWN'

export const CHECKOUT_PHASE = Object.freeze({
  LOCAL_CREATED: 'local_created',
  PROVIDER_PENDING: 'provider_pending',
  AWAITING_AUTHORIZATION: 'awaiting_authorization',
  RETRYABLE_REJECTION: 'retryable_rejection',
  AMBIGUOUS: 'ambiguous',
  TERMINAL_FAILURE: 'terminal_failure',
  CAPACITY_EXHAUSTED: 'capacity_exhausted',
})

function intEnv(name, fallback, min, max) {
  const n = Number(process.env[name])
  const v = Number.isFinite(n) ? Math.floor(n) : fallback
  return Math.min(max, Math.max(min, v))
}

export function sonicpesaCheckoutLimits() {
  return {
    maxConcurrent: intEnv('SONICPESA_CREATE_MAX_CONCURRENT', 4, 1, 8),
    queueWaitMs: intEnv('SONICPESA_CREATE_QUEUE_WAIT_MS', 8000, 0, 20000),
    dedupMs: intEnv('SONICPESA_CHECKOUT_DEDUP_MS', 180000, 30000, 600000),
    retry429Ms: intEnv('SONICPESA_429_COOLDOWN_MS', 60000, 15000, 300000),
    ambiguousHoldMs: intEnv('SONICPESA_AMBIGUOUS_HOLD_MS', 180000, 60000, 600000),
    maxPayAttempts: SONICPESA_PAY_ATTEMPT_MAX,
    attemptCooldownMs: SONICPESA_PAY_ATTEMPT_COOLDOWN_MS,
  }
}

/**
 * Same device, phone, and plan share one attempt window.
 * The key and phone hash are not reversible to the full phone number.
 */
export function sonicpesaPayAttemptIdentity({ deviceId, phone, planId }) {
  const device = String(deviceId ?? '').trim()
  const phoneNorm = String(phone ?? '').replace(/\D/g, '')
  const plan = Number(planId)
  if (!device || !phoneNorm || !Number.isFinite(plan)) {
    throw new Error('SonicPesa attempt identity is incomplete')
  }
  const identityKey = createHash('sha256')
    .update(`osmani-sonicpesa-pay-attempt:${device}|${phoneNorm}|${plan}`)
    .digest('hex')
  const phoneHash = createHash('sha256').update(`osmani-sonicpesa-phone:${phoneNorm}`).digest('hex')
  return { identityKey, phoneHash, deviceId: device, planId: plan }
}

function cooldownSeconds(limits) {
  const ms = limits?.attemptCooldownMs ?? SONICPESA_PAY_ATTEMPT_COOLDOWN_MS
  return Math.round(ms / 1000)
}

/**
 * Read the persisted window without changing it.
 * Expired cooldowns stay stored until a later permitted attempt resets them.
 */
export function readPayAttemptGate(row, nowMs, limits = {}) {
  const now = Number(nowMs)
  if (!Number.isFinite(now)) throw new Error('server time is required')
  const attemptCount = Number(row?.attemptCount ?? 0)
  const cooldownUntilMs = row?.cooldownUntilMs == null ? null : Number(row.cooldownUntilMs)
  if (cooldownUntilMs != null && Number.isFinite(cooldownUntilMs) && now < cooldownUntilMs) {
    return {
      action: 'cooldown',
      attemptCount,
      cooldownUntilMs,
      serverNowMs: now,
      cooldownSeconds: cooldownSeconds(limits),
    }
  }
  return {
    action: 'open',
    attemptCount,
    serverNowMs: now,
    cooldownSeconds: cooldownSeconds(limits),
  }
}

/**
 * Authoritative transition for one customer create-order.
 * `nowMs` must be the database clock. The fourth attempt is not permitted.
 * A live cooldown is not extended or cleared by a rejected request.
 */
export function decidePayAttemptTransition(row, nowMs, limits = {}) {
  const max = limits.maxPayAttempts ?? SONICPESA_PAY_ATTEMPT_MAX
  const cooldownMs = limits.attemptCooldownMs ?? SONICPESA_PAY_ATTEMPT_COOLDOWN_MS
  const now = Number(nowMs)
  if (!Number.isFinite(now)) throw new Error('server time is required')
  const attemptCount = Number(row?.attemptCount ?? 0)
  const cooldownUntilMs = row?.cooldownUntilMs == null ? null : Number(row.cooldownUntilMs)
  const seconds = Math.round(cooldownMs / 1000)

  if (cooldownUntilMs != null && Number.isFinite(cooldownUntilMs) && now < cooldownUntilMs) {
    return {
      action: 'cooldown',
      attemptCount,
      cooldownUntilMs,
      serverNowMs: now,
      armCooldown: false,
      cooldownSeconds: seconds,
    }
  }

  const expired = cooldownUntilMs != null && Number.isFinite(cooldownUntilMs) && now >= cooldownUntilMs
  const baseCount = expired ? 0 : attemptCount
  if (baseCount >= max) {
    return {
      action: 'cooldown',
      attemptCount: baseCount,
      cooldownUntilMs: now + cooldownMs,
      serverNowMs: now,
      armCooldown: true,
      cooldownSeconds: seconds,
    }
  }

  const next = baseCount + 1
  return {
    action: 'permit',
    attemptCount: next,
    cooldownUntilMs: next >= max ? now + cooldownMs : null,
    serverNowMs: now,
    armCooldown: false,
    cooldownSeconds: seconds,
  }
}

/**
 * Decide whether this customer create-order may contact SonicPesa.
 * An accepted PIN prompt is not reused: a later customer checkout is a new attempt.
 * The previous order is left unchanged. Ambiguous and provider-429 holds do not
 * consume another attempt and do not call the provider.
 */
export function planSonicpesaCustomerAttempt({ recentRows, attemptRow, nowMs, limits } = {}) {
  const gate = readPayAttemptGate(attemptRow, nowMs, limits)
  if (gate.action === 'cooldown') {
    return {
      action: 'attempt_cooldown',
      gate,
      contactsProvider: false,
      createsTransaction: false,
      consumesAttempt: false,
    }
  }
  const dup = decideDuplicateCheckout(recentRows, nowMs, limits)
  if (dup.action !== 'create') {
    return {
      action: dup.action,
      dup,
      contactsProvider: false,
      createsTransaction: false,
      consumesAttempt: false,
    }
  }
  return {
    action: 'create',
    contactsProvider: true,
    createsTransaction: true,
    consumesAttempt: true,
  }
}

export function sonicpesaPayAttemptCooldownHttpBody(reservation, correlationId) {
  const untilMs = Number(reservation?.cooldownUntilMs)
  const nowMs = Number(reservation?.serverNowMs)
  const cooldownSecondsValue = SONICPESA_PAY_ATTEMPT_COOLDOWN_MS / 1000
  const remaining =
    Number.isFinite(untilMs) && Number.isFinite(nowMs)
      ? Math.max(1, Math.ceil((untilMs - nowMs) / 1000))
      : cooldownSecondsValue
  return {
    status: 429,
    retryAfterSeconds: remaining,
    body: {
      ok: false,
      code: SONICPESA_PAY_ATTEMPT_COOLDOWN_CODE,
      error: 'Umefikia majaribio matatu ya malipo. Subiri dakika tatu kisha ujaribu tena.',
      provider: 'sonicpesa',
      cooldown_seconds: cooldownSecondsValue,
      cooldown_until: new Date(untilMs).toISOString(),
      pin_wait_allowed: false,
      retryable: false,
      retry_after_seconds: remaining,
      correlation_id: correlationId ?? null,
    },
  }
}

export function providerOrderIdFromResult(result) {
  const body = result?.body && typeof result.body === 'object' ? result.body : {}
  const data = body.data && typeof body.data === 'object' ? body.data : null
  const id =
    result?.normalized?.providerOrderId ??
    (data?.order_id != null ? String(data.order_id) : '') ??
    (body.order_id != null ? String(body.order_id) : '')
  const s = String(id ?? '').trim()
  return s || null
}

function retryAfterMs(result, fallbackMs) {
  const raw = result?.retryAfter ?? result?.headers?.retryAfter ?? result?.headers?.['retry-after']
  const n = Number(String(raw ?? '').trim())
  if (Number.isFinite(n) && n >= 0 && n <= 3600) return Math.round(n * 1000)
  return fallbackMs
}

function looksLikeTimeout(result) {
  const status = Number(result?.status) || 0
  const err = String(result?.body?.error ?? result?.error ?? '')
  if (status === 408) return true
  if (status === 0) return /abort|timeout|timed out|network|fetch failed/i.test(err)
  return false
}

/**
 * @param {object} result createOrder() return value
 */
export function classifySonicpesaCreateResult(result, limits = sonicpesaCheckoutLimits()) {
  const httpStatus = Number(result?.status) || 0
  const providerOrderId = providerOrderIdFromResult(result)
  const accepted = result?.ok === true && Boolean(providerOrderId)
  if (accepted) {
    return {
      kind: 'accepted',
      httpStatus,
      providerOrderId,
      txnStatus: 'pending',
      providerInitiation: 'accepted',
      checkoutPhase: CHECKOUT_PHASE.AWAITING_AUTHORIZATION,
      pinWaitAllowed: true,
      retryable: false,
      enqueueReconcile: true,
    }
  }
  if (httpStatus === 429 && !providerOrderId) {
    return {
      kind: 'retryable_rejection',
      httpStatus: 429,
      providerOrderId: null,
      txnStatus: 'failed',
      providerInitiation: 'rejected_retryable',
      checkoutPhase: CHECKOUT_PHASE.RETRYABLE_REJECTION,
      pinWaitAllowed: false,
      retryable: true,
      retryAfterMs: retryAfterMs(result, limits.retry429Ms),
      enqueueReconcile: false,
      userMessage: 'Maombi mengi sana. Subiri kidogo kisha ujaribu tena.',
    }
  }
  if (httpStatus === 429 && providerOrderId) {
    return {
      kind: 'ambiguous',
      httpStatus: 429,
      providerOrderId,
      txnStatus: 'pending',
      providerInitiation: 'ambiguous',
      checkoutPhase: CHECKOUT_PHASE.AMBIGUOUS,
      pinWaitAllowed: false,
      retryable: false,
      enqueueReconcile: true,
      userMessage: 'Hatujapata jibu la malipo. Subiri kidogo usijaribu mara mbili.',
    }
  }
  if (looksLikeTimeout(result) || httpStatus >= 500 || (result?.ok === true && !providerOrderId)) {
    return {
      kind: 'ambiguous',
      httpStatus,
      providerOrderId: providerOrderId || null,
      txnStatus: 'pending',
      providerInitiation: 'ambiguous',
      checkoutPhase: CHECKOUT_PHASE.AMBIGUOUS,
      pinWaitAllowed: false,
      retryable: false,
      enqueueReconcile: false,
      userMessage: 'Hatujapata jibu la malipo. Subiri kidogo usijaribu mara mbili.',
    }
  }
  return {
    kind: 'terminal_rejection',
    httpStatus,
    providerOrderId: null,
    txnStatus: 'failed',
    providerInitiation: 'failed',
    checkoutPhase: CHECKOUT_PHASE.TERMINAL_FAILURE,
    pinWaitAllowed: false,
    retryable: false,
    enqueueReconcile: false,
    userMessage: 'Imeshindwa kuanzisha malipo. Jaribu tena baadae.',
  }
}

export function pinWaitAllowedFromTxn(txn) {
  const raw = txn?.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  const providerOrderId = String(raw.provider_order_id ?? txn?.external_id ?? '').trim()
  const initiation = String(raw.provider_initiation ?? '').trim()
  return initiation === 'accepted' && Boolean(providerOrderId)
}

/**
 * Poll SonicPesa only when this checkout was accepted and has a provider reference.
 * Merchant order ids are not sent (SONICPESA_INCLUDE_MERCHANT_REF is not enabled),
 * so polling osm_sp_… cannot find the payment.
 */
export function shouldActivelyReconcile(txn) {
  if (String(txn?.status ?? '') !== 'pending') return false
  const raw = txn?.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  const provider = String(raw.payment_provider ?? '').trim()
  if (provider && provider !== 'sonicpesa') return false
  const providerOrderId = String(raw.provider_order_id ?? txn?.external_id ?? '').trim()
  if (!providerOrderId) return false
  const initiation = String(raw.provider_initiation ?? '').trim()
  return initiation === 'accepted' || initiation === 'ambiguous'
}

/** Completed checkouts with a rejection marker must not grant entitlement. */
export function checkoutAllowsEntitlement(txn) {
  if (String(txn?.status ?? '') !== 'completed') return false
  const raw = txn?.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  const phase = String(raw.checkout_phase ?? '')
  const initiation = String(raw.provider_initiation ?? '')
  if (phase === CHECKOUT_PHASE.RETRYABLE_REJECTION || phase === CHECKOUT_PHASE.TERMINAL_FAILURE) {
    return false
  }
  if (initiation === 'rejected_retryable') return false
  return true
}

/**
 * @param {Array<object>} rows newest first, already scoped to this device
 */
export function decideDuplicateCheckout(rows, nowMs, limits = sonicpesaCheckoutLimits()) {
  const list = Array.isArray(rows) ? rows : []
  for (const row of list) {
    const created = new Date(row.updated_at || row.created_at || 0).getTime()
    const age = Number.isFinite(created) ? nowMs - created : Number.POSITIVE_INFINITY
    const initiation = String(row.provider_initiation ?? row.raw_payload?.provider_initiation ?? '')
    const httpStatus = Number(row.httpStatus ?? row.raw_payload?.httpStatus) || 0
    const providerOrderId = String(
      row.provider_order_id ?? row.external_id ?? row.raw_payload?.provider_order_id ?? '',
    ).trim()
    const status = String(row.status ?? '')
    // An accepted PIN prompt stays recorded. Closing the app does not cancel it.
    // A later customer create-order is a separate attempt (see the attempt window).
    // Ambiguous or still-unanswered provider calls must not start another request.
    const unanswered =
      status === 'pending' &&
      age < limits.ambiguousHoldMs &&
      (!providerOrderId || initiation === 'ambiguous' || initiation === 'provider_pending')
    if (unanswered) {
      return { action: 'block_ambiguous', orderId: row.order_id }
    }
    if (
      !providerOrderId &&
      (initiation === 'rejected_retryable' || httpStatus === 429) &&
      age >= 0 &&
      age < limits.retry429Ms
    ) {
      return {
        action: 'block_429',
        orderId: row.order_id,
        retryAfterMs: Math.max(1000, limits.retry429Ms - age),
      }
    }
  }
  return { action: 'create' }
}

const PHONE_KEYS = ['buyer_phone', 'phone', 'phoneNorm', 'msisdn', 'customer_phone']

export function redactPaymentBody(body) {
  if (!body || typeof body !== 'object') return body ?? null
  const out = Array.isArray(body) ? [] : {}
  for (const [k, v] of Object.entries(body)) {
    if (PHONE_KEYS.includes(k) || /phone|msisdn|secret|api[_-]?key|authorization/i.test(k)) {
      out[k] = '[redacted]'
      continue
    }
    if (v && typeof v === 'object') out[k] = redactPaymentBody(v)
    else out[k] = v
  }
  return out
}
