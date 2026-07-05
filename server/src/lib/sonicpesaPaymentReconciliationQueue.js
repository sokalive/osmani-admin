/**
 * Durable SonicPesa pending-order reconciliation (poll fallback survives PM2 restart).
 */
import { getPool } from '../db/pool.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import { getSonicpesaWebhookHealthSnapshot } from './sonicpesaWebhookHealth.js'

const QUEUE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  TERMINAL_FAILED: 'TERMINAL_FAILED',
  TERMINAL_ABANDONED: 'TERMINAL_ABANDONED',
})

const MAX_ATTEMPTS = Math.max(5, Number(process.env.SONICPESA_RECONCILE_QUEUE_MAX_ATTEMPTS) || 24)
const WORKER_MS = Math.max(15_000, Number(process.env.SONICPESA_RECONCILE_QUEUE_MS) || 45_000)
const BATCH = Math.min(20, Math.max(1, Number(process.env.SONICPESA_RECONCILE_QUEUE_BATCH) || 8))

let workerTimer = null
let workerRunning = false

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function nextAttemptAt(attemptCount, priority = 0) {
  const base = priority > 0 ? 2000 : 8000
  const exp = Math.min(8, Math.max(0, attemptCount))
  const ms = base * 2 ** exp
  const jitter = Math.floor(Math.random() * Math.min(4000, ms * 0.15))
  return new Date(Date.now() + ms + jitter)
}

export async function enqueueSonicpesaPaymentReconciliation(orderId, deviceId, { priority = 1 } = {}) {
  const pool = requirePool()
  const oid = String(orderId ?? '').trim()
  const did = String(deviceId ?? '').trim()
  if (!oid) return null
  const { rows } = await pool.query(
    `INSERT INTO sonicpesa_payment_reconciliation_queue (order_id, device_id, status, priority, next_attempt_at)
     VALUES ($1, $2, 'PENDING', $3, now())
     ON CONFLICT (order_id) DO UPDATE SET
       device_id = COALESCE(NULLIF(EXCLUDED.device_id, ''), sonicpesa_payment_reconciliation_queue.device_id),
       priority = GREATEST(sonicpesa_payment_reconciliation_queue.priority, EXCLUDED.priority),
       status = CASE
         WHEN sonicpesa_payment_reconciliation_queue.status IN ('COMPLETED', 'TERMINAL_FAILED', 'TERMINAL_ABANDONED')
           THEN sonicpesa_payment_reconciliation_queue.status
         ELSE 'PENDING'
       END,
       next_attempt_at = LEAST(sonicpesa_payment_reconciliation_queue.next_attempt_at, now()),
       updated_at = now()
     RETURNING *`,
    [oid, did, Number(priority) || 0],
  )
  return rows[0] ?? null
}

export async function claimReconciliationQueueRows(limit = BATCH) {
  const pool = requirePool()
  const n = Math.min(30, Math.max(1, Number(limit) || BATCH))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT q.*
       FROM sonicpesa_payment_reconciliation_queue q
       INNER JOIN transactions t ON t.order_id = q.order_id
       WHERE q.status = 'PENDING'
         AND q.attempt_count < $2
         AND q.next_attempt_at <= now()
         AND t.status = 'pending'
         AND COALESCE(t.raw_payload->>'payment_provider', '') = 'sonicpesa'
       ORDER BY q.priority DESC, q.created_at ASC
       LIMIT $1
       FOR UPDATE OF q SKIP LOCKED`,
      [n, MAX_ATTEMPTS],
    )
    const ids = rows.map((r) => Number(r.id))
    if (ids.length) {
      await client.query(
        `UPDATE sonicpesa_payment_reconciliation_queue
         SET status = 'PROCESSING', updated_at = now()
         WHERE id = ANY($1::bigint[])`,
        [ids],
      )
    }
    await client.query('COMMIT')
    return rows
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

async function finalizeQueueRow(id, { status, lastError = '', attemptDelta = 0, schedule = false, attemptCount = 0, priority = 0 }) {
  const pool = requirePool()
  const retryAt = schedule ? nextAttemptAt(attemptCount + attemptDelta, priority).toISOString() : null
  await pool.query(
    `UPDATE sonicpesa_payment_reconciliation_queue SET
       status = $2,
       attempt_count = attempt_count + $3,
       last_error_redacted = COALESCE(NULLIF($4, ''), last_error_redacted),
       next_attempt_at = COALESCE($5::timestamptz, next_attempt_at),
       completed_at = CASE WHEN $2 IN ('COMPLETED', 'TERMINAL_FAILED', 'TERMINAL_ABANDONED') THEN now() ELSE completed_at END,
       updated_at = now()
     WHERE id = $1`,
    [id, status, attemptDelta, String(lastError).slice(0, 500), retryAt],
  )
}

export async function processReconciliationQueueRow(row) {
  const oid = String(row.order_id ?? '').trim()
  const rec = await reconcileOrderWithZenoPay(oid, { forcePoll: true })
  const after = String(rec.txnStatusAfter ?? rec.txnStatusBefore ?? '').trim()

  if (after === 'completed' || after === 'failed') {
    await finalizeQueueRow(row.id, { status: QUEUE_STATUS.COMPLETED, attemptDelta: 1 })
    return { orderId: oid, terminal: true, status: after, rec }
  }

  const exhausted = Number(row.attempt_count ?? 0) + 1 >= MAX_ATTEMPTS
  if (exhausted) {
    await finalizeQueueRow(row.id, {
      status: QUEUE_STATUS.TERMINAL_ABANDONED,
      lastError: rec.phase || 'max_attempts',
      attemptDelta: 1,
    })
    return { orderId: oid, terminal: true, status: 'abandoned', rec }
  }

  await finalizeQueueRow(row.id, {
    status: QUEUE_STATUS.PENDING,
    lastError: rec.phase || 'still_pending',
    attemptDelta: 1,
    schedule: true,
    attemptCount: Number(row.attempt_count ?? 0),
    priority: Number(row.priority ?? 0),
  })
  return { orderId: oid, terminal: false, status: after || 'pending', rec }
}

export async function runSonicpesaReconciliationQueueOnce() {
  if (workerRunning) return { skipped: true, processed: 0 }
  workerRunning = true
  let processed = 0
  try {
    const health = await getSonicpesaWebhookHealthSnapshot()
    const webhookStale = Number(health?.provider_webhook_age_sec ?? 0) > 3600
    const batch = webhookStale ? Math.min(BATCH + 4, 20) : BATCH
    const rows = await claimReconciliationQueueRows(batch)
    for (const row of rows) {
      try {
        await processReconciliationQueueRow(row)
        processed += 1
      } catch (e) {
        await finalizeQueueRow(row.id, {
          status: QUEUE_STATUS.PENDING,
          lastError: String(e?.message || e).slice(0, 200),
          attemptDelta: 1,
          schedule: true,
          attemptCount: Number(row.attempt_count ?? 0),
          priority: Number(row.priority ?? 0),
        })
      }
    }
    return { skipped: false, processed, webhook_stale_boost: webhookStale }
  } finally {
    workerRunning = false
  }
}

export async function getReconciliationQueueMetrics() {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
       COUNT(*) FILTER (WHERE status = 'PROCESSING')::int AS processing,
       COUNT(*) FILTER (WHERE status = 'COMPLETED')::int AS completed,
       COUNT(*) FILTER (WHERE status = 'TERMINAL_ABANDONED')::int AS terminal_abandoned,
       MIN(created_at) FILTER (WHERE status = 'PENDING') AS oldest_pending_at
     FROM sonicpesa_payment_reconciliation_queue`,
  )
  return rows[0] ?? {}
}

export function startSonicpesaReconciliationQueueWorker() {
  if (workerTimer || process.env.SONICPESA_RECONCILE_QUEUE_WORKER === '0') return
  workerTimer = setInterval(() => {
    void runSonicpesaReconciliationQueueOnce().catch((e) => {
      console.warn('[sonicpesa-reconcile-queue]', e?.message || e)
    })
  }, WORKER_MS)
  if (typeof workerTimer.unref === 'function') workerTimer.unref()
  void runSonicpesaReconciliationQueueOnce().catch(() => {})
  console.log('[sonicpesa-reconcile-queue] started', { intervalMs: WORKER_MS })
}
