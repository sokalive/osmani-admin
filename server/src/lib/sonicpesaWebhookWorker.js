/**
 * Process SonicPesa webhook inbox rows + background retry worker.
 */
import * as billing from '../billingStore.js'
import {
  applySonicpesaPaymentOutcome,
  COMPLETION_SOURCE,
  ACTIVATION_STATE,
} from './canonicalPaymentActivation.js'
import {
  claimInboxRowsForRetry,
  getInboxMetrics,
  INBOX_STATUS,
  isInboxRetryExhausted,
  updateInboxStatus,
} from './sonicpesaWebhookInbox.js'
import { sonicExplicitFailure, sonicPaymentSucceeded, webhookOrderIdCandidates, isProviderCompletionEvent, webhookAmountMatchesTxn } from './sonicpesaWebhookHelpers.js'
import { notifySubscriptionActivatedFromAct } from './subscriptionActivationNotify.js'
import { liveSyncBus } from './liveSyncBus.js'

const WORKER_INTERVAL_MS = Math.max(5_000, Number(process.env.SONICPESA_INBOX_WORKER_MS) || 15_000)
const WORKER_BATCH = Math.min(40, Math.max(5, Number(process.env.SONICPESA_INBOX_WORKER_BATCH) || 20))
const ROW_CONCURRENCY = Math.min(8, Math.max(1, Number(process.env.SONICPESA_INBOX_ROW_CONCURRENCY) || 4))
let workerTimer = null
let workerRunning = false
let workerKickScheduled = false

/** Non-blocking worker kick after durable inbox capture (match-day burst safe). */
export function kickSonicpesaInboxWorker() {
  if (workerKickScheduled || process.env.SONICPESA_INBOX_WORKER === '0') return
  workerKickScheduled = true
  setImmediate(() => {
    workerKickScheduled = false
    void runSonicpesaInboxWorkerOnce().catch((e) => {
      console.warn('[sonicpesa-inbox-worker] kick failed:', e?.message || e)
    })
  })
}

async function resolveTransactionForWebhook(body) {
  const ids = webhookOrderIdCandidates(body)
  for (const id of ids) {
    const txn = await billing.getTransactionByOrderId(id)
    if (txn) return { txn, merchantOrderId: String(txn.order_id), candidateIds: ids }
  }
  for (const id of ids) {
    const txn = await billing.getTransactionByExternalId(id)
    if (txn) return { txn, merchantOrderId: String(txn.order_id), candidateIds: ids }
  }
  return { txn: null, merchantOrderId: null, candidateIds: ids }
}

/**
 * Process one inbox row (webhook payload).
 */
export async function processSonicpesaInboxRow(row) {
  const inboxId = Number(row?.id)
  const body = row?.payload && typeof row.payload === 'object' ? row.payload : {}
  const signatureOk = row?.signature_verified === true

  if (!signatureOk) {
    await updateInboxStatus(inboxId, {
      status: INBOX_STATUS.TERMINAL_REJECTED,
      lastError: 'invalid_signature',
    })
    return { inboxId, ok: false, reason: 'invalid_signature' }
  }

  const resolved = await resolveTransactionForWebhook(body)
  const { txn, merchantOrderId, candidateIds } = resolved

  if (!txn || !merchantOrderId) {
    await updateInboxStatus(inboxId, {
      status: INBOX_STATUS.TERMINAL_REJECTED,
      lastError: `unknown_order:${(candidateIds ?? []).slice(0, 3).join(',')}`,
    })
    return { inboxId, ok: false, reason: 'unknown_order' }
  }

  if (!isProviderCompletionEvent(body)) {
    await updateInboxStatus(inboxId, {
      status: INBOX_STATUS.PROCESSED,
      lastError: 'ignored_non_completion_event',
    })
    return { inboxId, ok: true, reason: 'ignored_non_completion_event' }
  }

  const ok = sonicPaymentSucceeded(body)
  const fail = sonicExplicitFailure(body)
  if (!ok && !fail) {
    await updateInboxStatus(inboxId, {
      status: INBOX_STATUS.TERMINAL_REJECTED,
      lastError: 'unconfirmed_payment_status',
    })
    return { inboxId, ok: false, reason: 'unconfirmed_payment_status' }
  }

  if (ok && !webhookAmountMatchesTxn(txn, body)) {
    await updateInboxStatus(inboxId, {
      status: INBOX_STATUS.TERMINAL_REJECTED,
      lastError: 'amount_mismatch',
    })
    return { inboxId, ok: false, reason: 'amount_mismatch' }
  }

  const data = body.data && typeof body.data === 'object' ? body.data : body
  const transId =
    data.transid ?? data.transaction_id ?? body.transid ?? body.transaction_id ?? body.external_id
  const providerOrderId = String(data.order_id ?? body.order_id ?? txn.external_id ?? '').trim()

  const result = await applySonicpesaPaymentOutcome({
    orderId: merchantOrderId,
    source: COMPLETION_SOURCE.SONIC_WEBHOOK,
    succeeded: ok,
    failed: fail,
    providerPayload: body,
    externalId:
      transId != null ? String(transId) : providerOrderId || txn.external_id,
  })

  const act = result.activation
  if (act?.activation_state === ACTIVATION_STATE.RETRYABLE_DB_ERROR) {
    const exhausted = isInboxRetryExhausted(Number(row.attempt_count ?? 0) + 1)
    await updateInboxStatus(inboxId, {
      status: exhausted ? INBOX_STATUS.TERMINAL_REJECTED : INBOX_STATUS.RETRYABLE_ERROR,
      lastError: act.error || 'db_error',
      incrementAttempt: true,
      scheduleRetry: !exhausted,
    })
    return { inboxId, ok: false, reason: 'retryable_db_error', result }
  }

  if (result.txnStatusAfter) {
    liveSyncBus.publish('analytics.transaction_updated', {
      topics: ['analytics'],
      orderId: merchantOrderId,
      status: result.txnStatusAfter,
      deviceId: txn.device_id,
    })
  }

  if (act?.activated && act.deviceId) {
    notifySubscriptionActivatedFromAct(act, merchantOrderId)
  }

  await updateInboxStatus(inboxId, { status: INBOX_STATUS.PROCESSED })
  return { inboxId, ok: true, result }
}

export async function runSonicpesaInboxWorkerOnce() {
  if (workerRunning) return { skipped: true, processed: 0 }
  workerRunning = true
  let processed = 0
  try {
    const rows = await claimInboxRowsForRetry(WORKER_BATCH)
    let idx = 0
    async function rowWorker() {
      while (idx < rows.length) {
        const row = rows[idx++]
        try {
          await processSonicpesaInboxRow(row)
          processed += 1
        } catch (e) {
          const exhausted = isInboxRetryExhausted(Number(row.attempt_count ?? 0) + 1)
          await updateInboxStatus(row.id, {
            status: exhausted ? INBOX_STATUS.TERMINAL_REJECTED : INBOX_STATUS.RETRYABLE_ERROR,
            lastError: String(e?.message || e).slice(0, 200),
            incrementAttempt: true,
            scheduleRetry: !exhausted,
          })
        }
      }
    }
    const workers = Math.min(ROW_CONCURRENCY, rows.length)
    if (workers > 0) {
      await Promise.all(Array.from({ length: workers }, () => rowWorker()))
    }
    return { skipped: false, processed, metrics: await getInboxMetrics() }
  } finally {
    workerRunning = false
  }
}

export function startSonicpesaInboxWorker() {
  if (workerTimer || process.env.SONICPESA_INBOX_WORKER === '0') return
  workerTimer = setInterval(() => {
    void runSonicpesaInboxWorkerOnce().catch((e) => {
      console.warn('[sonicpesa-inbox-worker]', e?.message || e)
    })
  }, WORKER_INTERVAL_MS)
  if (typeof workerTimer.unref === 'function') workerTimer.unref()
  void runSonicpesaInboxWorkerOnce().catch(() => {})
  console.log('[sonicpesa-inbox-worker] started', { intervalMs: WORKER_INTERVAL_MS })
}

export function stopSonicpesaInboxWorker() {
  if (workerTimer) {
    clearInterval(workerTimer)
    workerTimer = null
  }
}
