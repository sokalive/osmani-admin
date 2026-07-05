/**
 * Reconcile DB transaction state with ZenoPay before subscription-status / payment-status return.
 * Fixes race: user pays and returns to app before webhook marks `transactions` completed.
 */
import * as billing from './billingStore.js'
import { webhookExplicitFailure, webhookSuccess } from './handlers/zenoPayWebhook.js'
import { liveSyncBus } from './lib/liveSyncBus.js'
import { notifySubscriptionActivatedFromAct } from './lib/subscriptionActivationNotify.js'
import { auraxpayGetOrderStatus, resolveAuraxpayCredentials } from './auraxpayClient.js'
import { resolveSonicpesaCredentials, sonicpesaGetOrderStatus } from './sonicpesaClient.js'
import { resolveZenopayCredentials, zenopayGetOrderStatus } from './zenopayClient.js'

const TRACE = String(process.env.ACTIVATION_TRACE || '').trim() === '1'
const reconcileInFlight = new Map()

function log(...args) {
  if (TRACE) console.log('[activation-sync]', ...args)
}

function shortId(s, n = 10) {
  const x = String(s ?? '')
  return x.length <= n ? x : `${x.slice(0, n)}…`
}

function emitIfActivated(act, orderId) {
  notifySubscriptionActivatedFromAct(act, orderId)
}

async function recordReconcilePollAttempt(oid, txn, body) {
  const prevPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  await billing.updateTransactionByOrderId(oid, {
    raw_payload: {
      ...prevPayload,
      order_status_poll: body,
      orderStatusPolledAt: new Date().toISOString(),
    },
  })
}

/**
 * Poll ZenoPay order-status for pending txns; complete + activate (same as webhook path).
 * Idempotent for already-completed rows (runs activation repair).
 * @param {string} orderId
 * @param {{ forcePoll?: boolean }} [opts] — bypass provider poll throttle (post-payment verify / boost polls)
 */
export async function reconcileOrderWithZenoPay(orderId, opts = {}) {
  const forcePoll = opts?.forcePoll === true
  const oid = String(orderId ?? '').trim()
  if (!oid) {
    return { orderId: oid, phase: 'missing_order_id' }
  }
  if (!forcePoll && reconcileInFlight.has(oid)) {
    return reconcileInFlight.get(oid)
  }
  const run = _reconcileOrderWithZenoPayInner(oid, { forcePoll })
  if (!forcePoll) reconcileInFlight.set(oid, run)
  try {
    return await run
  } finally {
    if (!forcePoll) reconcileInFlight.delete(oid)
  }
}

async function _reconcileOrderWithZenoPayInner(orderId, opts = {}) {
  const forcePoll = opts?.forcePoll === true
  const oid = String(orderId ?? '').trim()
  const out = {
    orderId: oid,
    phase: 'start',
    txnStatusBefore: null,
    txnStatusAfter: null,
    providerHttpOk: null,
    transitionedToCompleted: false,
    activation: null,
  }

  if (!oid) {
    out.phase = 'missing_order_id'
    return out
  }

  let txn = await billing.getTransactionByOrderId(oid)
  if (!txn) {
    out.phase = 'txn_not_found'
    log('no txn', shortId(oid))
    return out
  }

  out.txnStatusBefore = String(txn.status ?? '')
  log('txn snapshot', { orderId: shortId(oid), status: out.txnStatusBefore, device_id: shortId(txn.device_id) })

  if (txn.status === 'completed') {
    out.phase = 'already_completed_activate'
    const { activateFromCompletedTxn, COMPLETION_SOURCE } = await import(
      './lib/canonicalPaymentActivation.js'
    )
    const act = await activateFromCompletedTxn(txn, { source: COMPLETION_SOURCE.APP_VERIFY })
    out.activation = act
    out.txnStatusAfter = 'completed'
    emitIfActivated(act, oid)
    console.log('[activation-sync] completed txn activation', {
      orderId: shortId(oid),
      reason: act.reason,
      activated: act.activated === true,
      deviceId: act.deviceId ? shortId(act.deviceId, 16) : null,
    })
    return out
  }

  if (txn.status === 'failed') {
    out.phase = 'already_failed'
    out.txnStatusAfter = 'failed'
    return out
  }

  if (txn.status !== 'pending') {
    out.phase = 'unexpected_status'
    out.txnStatusAfter = String(txn.status ?? '')
    return out
  }

  const rawPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  const polledAt = rawPayload.orderStatusPolledAt
  const minPollMs = Math.max(
    3000,
    Number(process.env.SUBSCRIPTION_RECONCILE_MIN_INTERVAL_MS) || 15_000,
  )
  if (!forcePoll && polledAt) {
    const ageMs = Date.now() - new Date(polledAt).getTime()
    if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < minPollMs) {
      out.phase = 'poll_throttled'
      out.txnStatusAfter = 'pending'
      log('provider poll throttled', { orderId: shortId(oid), ageMs, minPollMs })
      return out
    }
  }

  if (rawPayload.payment_provider === 'sonicpesa') {
    const srow = await billing.getSonicpesaRow()
    const scred = resolveSonicpesaCredentials(srow || {})
    const verifyId = String(rawPayload.provider_order_id ?? txn.external_id ?? oid).trim()
    const z = await sonicpesaGetOrderStatus(scred, verifyId)
    out.providerHttpOk = z.ok === true
    log('sonicpesa order-status', {
      orderId: shortId(oid),
      verifyId: shortId(verifyId),
      httpOk: z.ok,
      status: z.status,
    })

    if (!z.ok || z.body == null) {
      out.phase = 'provider_request_failed'
      console.warn('[activation-sync] SonicPesa order-status failed', {
        orderId: shortId(oid),
        verifyId: shortId(verifyId),
        httpStatus: z.status,
        body: typeof z.body === 'object' ? z.body : String(z.body).slice(0, 200),
      })
      return out
    }

    const body = z.body
    const ok = z.normalized?.succeeded === true || webhookSuccess(body)
    const fail = z.normalized?.failed === true || webhookExplicitFailure(body)

    if (!ok && !fail) {
      out.phase = 'still_pending_or_unknown'
      await recordReconcilePollAttempt(oid, txn, body)
      console.log('[activation-sync] SonicPesa still pending', {
        orderId: shortId(oid),
        verifyId: shortId(verifyId),
        payment_status: z.normalized?.paymentStatus ?? body?.data?.payment_status ?? null,
      })
      return out
    }

    const { applySonicpesaPaymentOutcome, COMPLETION_SOURCE } = await import(
      './lib/canonicalPaymentActivation.js'
    )
    const result = await applySonicpesaPaymentOutcome({
      orderId: oid,
      source: COMPLETION_SOURCE.ORDER_STATUS_POLL,
      succeeded: ok,
      failed: fail,
      providerPayload: body,
      externalId: body.transaction_id != null ? String(body.transaction_id) : txn.external_id,
    })

    out.transitionedToCompleted = result.txnStatusAfter === 'completed' && result.transitioned
    out.txnStatusAfter = result.txnStatusAfter ?? txn.status
    out.phase =
      result.txnStatusAfter === 'completed'
        ? 'transitioned_completed'
        : result.txnStatusAfter === 'failed'
          ? 'transitioned_failed'
          : 'still_pending_or_unknown'
    out.activation = result.activation

    if (result.txnStatusAfter && result.txnStatusAfter !== out.txnStatusBefore) {
      liveSyncBus.publish('analytics.transaction_updated', {
        topics: ['analytics'],
        orderId: oid,
        status: result.txnStatusAfter,
      })
    }

    emitIfActivated(result.activation, oid)
    console.log('[activation-sync] SonicPesa poll completed + activation', {
      orderId: shortId(oid),
      reason: result.activation?.reason ?? result.activation?.activation_state,
      activated: result.activation?.activated === true,
      deviceId: result.activation?.deviceId ? shortId(result.activation.deviceId, 16) : null,
    })
    return out
  }

  if (rawPayload.payment_provider === 'auraxpay') {
    const arow = await billing.getAuraxpayRow()
    const acred = resolveAuraxpayCredentials(arow || {})
    const verifyId = String(oid).trim()
    const z = await auraxpayGetOrderStatus(acred, verifyId)
    out.providerHttpOk = z.ok === true
    log('auraxpay order-status', {
      orderId: shortId(oid),
      verifyId: shortId(verifyId),
      httpOk: z.ok,
      status: z.status,
    })

    if (!z.ok || z.body == null) {
      out.phase = 'provider_request_failed'
      console.warn('[activation-sync] Aurax Pay order-status failed', {
        orderId: shortId(oid),
        verifyId: shortId(verifyId),
        httpStatus: z.status,
      })
      return out
    }

    const body = z.body
    const ok = z.normalized?.succeeded === true || webhookSuccess(body)
    const fail = z.normalized?.failed === true || webhookExplicitFailure(body)
    const nextStatus = ok ? 'completed' : fail ? 'failed' : txn.status

    if (nextStatus === txn.status) {
      out.phase = 'still_pending_or_unknown'
      await recordReconcilePollAttempt(oid, txn, body)
      return out
    }

    const prevPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    await billing.updateTransactionByOrderId(oid, {
      status: nextStatus,
      external_id: body.transaction_id != null ? String(body.transaction_id) : txn.external_id,
      raw_payload: {
        ...prevPayload,
        order_status_poll: body,
        orderStatusPolledAt: new Date().toISOString(),
      },
    })
    out.transitionedToCompleted = nextStatus === 'completed'
    out.txnStatusAfter = nextStatus
    out.phase = nextStatus === 'completed' ? 'transitioned_completed' : 'transitioned_failed'

    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId: oid,
      status: nextStatus,
    })

    if (nextStatus !== 'completed') {
      return out
    }

    txn = await billing.getTransactionByOrderId(oid)
    const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn(txn)
    out.activation = act
    emitIfActivated(act, oid)
    return out
  }

  const zenRow = await billing.getZenopayRow()
  const cred = resolveZenopayCredentials(zenRow || {})
  const z = await zenopayGetOrderStatus(cred, oid)
  out.providerHttpOk = z.ok === true
  log('provider order-status', { orderId: shortId(oid), httpOk: z.ok, status: z.status })

  if (!z.ok || z.body == null) {
    out.phase = 'provider_request_failed'
    console.warn('[activation-sync] ZenoPay order-status failed', {
      orderId: shortId(oid),
      httpStatus: z.status,
      body: typeof z.body === 'object' ? z.body : String(z.body).slice(0, 200),
    })
    return out
  }

  const body = z.body
  const ok = webhookSuccess(body)
  const fail = webhookExplicitFailure(body)
  const nextStatus = ok ? 'completed' : fail ? 'failed' : txn.status

  if (nextStatus === txn.status) {
    out.phase = 'still_pending_or_unknown'
    await recordReconcilePollAttempt(oid, txn, body)
    console.log('[activation-sync] provider did not confirm payment yet', {
      orderId: shortId(oid),
      resultcode: body?.resultcode,
      hint: TRACE ? body : undefined,
    })
    return out
  }

  const prevPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  await billing.updateTransactionByOrderId(oid, {
    status: nextStatus,
    external_id: body.transaction_id != null ? String(body.transaction_id) : txn.external_id,
    raw_payload: {
      ...prevPayload,
      order_status_poll: body,
      orderStatusPolledAt: new Date().toISOString(),
    },
  })
  out.transitionedToCompleted = nextStatus === 'completed'
  out.txnStatusAfter = nextStatus
  out.phase = nextStatus === 'completed' ? 'transitioned_completed' : 'transitioned_failed'

  console.log('[activation-sync] transaction row updated from provider', {
    orderId: shortId(oid),
    from: out.txnStatusBefore,
    to: nextStatus,
  })

  liveSyncBus.publish('analytics.transaction_updated', {
    topics: ['analytics'],
    orderId: oid,
    status: nextStatus,
  })

  if (nextStatus !== 'completed') {
    return out
  }

  txn = await billing.getTransactionByOrderId(oid)
  const act = await billing.tryActivateDeviceSubscriptionFromCompletedTxn(txn)
  out.activation = act
  emitIfActivated(act, oid)

  console.log('[activation-sync] device_subscriptions activation after poll', {
    orderId: shortId(oid),
    reason: act.reason,
    activated: act.activated === true,
    skipped: act.skipped,
    deviceId: act.deviceId ? shortId(act.deviceId, 16) : null,
  })

  return out
}
