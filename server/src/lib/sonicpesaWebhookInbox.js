/**
 * Durable SonicPesa webhook inbox — capture, dedupe, retry processing.
 */
import crypto from 'node:crypto'
import { getPool } from '../db/pool.js'

export const INBOX_STATUS = Object.freeze({
  RECEIVED: 'RECEIVED',
  VERIFIED: 'VERIFIED',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  RETRYABLE_ERROR: 'RETRYABLE_ERROR',
  TERMINAL_REJECTED: 'TERMINAL_REJECTED',
})

const MAX_ATTEMPTS = Math.max(3, Number(process.env.SONICPESA_INBOX_MAX_ATTEMPTS) || 12)
const BASE_RETRY_MS = Math.max(1000, Number(process.env.SONICPESA_INBOX_RETRY_BASE_MS) || 5000)

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

export function hashWebhookPayload(body) {
  const raw = JSON.stringify(body ?? {})
  return crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
}

function extractProviderEventId(body) {
  const o = body && typeof body === 'object' ? body : {}
  const id = String(o.event_id ?? o.id ?? o.webhook_id ?? '').trim()
  return id || null
}

function extractOrderIds(body) {
  const o = body && typeof body === 'object' ? body : {}
  const nested = [o.data, o.payment, o.payload, o.transaction].filter((x) => x && typeof x === 'object')
  const objs = [o, ...nested]
  const keys = ['order_id', 'orderId', 'merchant_order_id', 'merchant_reference', 'reference', 'tx_ref']
  let providerOrderId = ''
  let merchantOrderId = ''
  for (const obj of objs) {
    for (const k of keys) {
      const v = String(obj[k] ?? '').trim()
      if (!v) continue
      if (!merchantOrderId && (k.includes('merchant') || k === 'reference' || k === 'tx_ref')) {
        merchantOrderId = v
      }
      if (!providerOrderId && (k === 'order_id' || k === 'orderId')) {
        providerOrderId = v
      }
    }
  }
  return { providerOrderId, merchantOrderId }
}

function nextRetryAt(attemptCount) {
  const exp = Math.min(6, Math.max(0, attemptCount))
  const ms = BASE_RETRY_MS * 2 ** exp
  const jitter = Math.floor(Math.random() * Math.min(3000, ms * 0.1))
  return new Date(Date.now() + ms + jitter)
}

/**
 * Insert webhook payload durably. Returns { id, duplicate, row }.
 */
export async function insertSonicpesaWebhookInbox({
  payload,
  signatureVerified = false,
  inboxSource = 'provider',
}) {
  const pool = requirePool()
  const body = payload && typeof payload === 'object' ? payload : {}
  const payloadHash = hashWebhookPayload(body)
  const providerEventId = extractProviderEventId(body)
  const { providerOrderId, merchantOrderId } = extractOrderIds(body)

  try {
    const { rows } = await pool.query(
      `INSERT INTO sonicpesa_webhook_inbox (
         provider_event_id, provider_order_id, merchant_order_id,
         payload_hash, signature_verified, payload, processing_status, inbox_source
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING *`,
      [
        providerEventId,
        providerOrderId,
        merchantOrderId,
        payloadHash,
        signatureVerified,
        JSON.stringify(body),
        signatureVerified ? INBOX_STATUS.VERIFIED : INBOX_STATUS.RECEIVED,
        String(inboxSource || 'provider').slice(0, 32),
      ],
    )
    return { id: Number(rows[0].id), duplicate: false, row: rows[0] }
  } catch (e) {
    if (e?.code === '23505') {
      const { rows } = await pool.query(
        `SELECT * FROM sonicpesa_webhook_inbox WHERE payload_hash = $1 LIMIT 1`,
        [payloadHash],
      )
      return { id: Number(rows[0]?.id ?? 0), duplicate: true, row: rows[0] ?? null }
    }
    throw e
  }
}

export async function updateInboxStatus(id, {
  status,
  lastError = '',
  incrementAttempt = false,
  scheduleRetry = false,
}) {
  const pool = requirePool()
  const inboxId = Number(id)
  if (!Number.isFinite(inboxId) || inboxId < 1) return null
  const attemptDelta = incrementAttempt ? 1 : 0
  const processedAt =
    status === INBOX_STATUS.PROCESSED || status === INBOX_STATUS.TERMINAL_REJECTED
      ? new Date().toISOString()
      : null
  const retryAt = scheduleRetry ? nextRetryAt(attemptDelta).toISOString() : null
  const { rows } = await pool.query(
    `UPDATE sonicpesa_webhook_inbox SET
       processing_status = $2,
       attempt_count = attempt_count + $3,
       last_error_redacted = COALESCE(NULLIF($4, ''), last_error_redacted),
       processed_at = COALESCE($5::timestamptz, processed_at),
       next_retry_at = COALESCE($6::timestamptz, next_retry_at),
       updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [inboxId, status, attemptDelta, String(lastError ?? '').slice(0, 500), processedAt, retryAt],
  )
  return rows[0] ?? null
}

export async function claimInboxRowsForRetry(limit = 10) {
  const pool = requirePool()
  const n = Math.min(50, Math.max(1, Number(limit) || 10))
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT * FROM sonicpesa_webhook_inbox
       WHERE processing_status IN ('RECEIVED', 'VERIFIED', 'RETRYABLE_ERROR')
         AND attempt_count < $2
         AND (next_retry_at IS NULL OR next_retry_at <= now())
       ORDER BY received_at ASC
       LIMIT $1
       FOR UPDATE SKIP LOCKED`,
      [n, MAX_ATTEMPTS],
    )
    const ids = rows.map((r) => Number(r.id))
    if (ids.length > 0) {
      await client.query(
        `UPDATE sonicpesa_webhook_inbox
         SET processing_status = 'PROCESSING', updated_at = now()
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

export async function getInboxMetrics() {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT
       COUNT(*)::int AS total,
       COUNT(*) FILTER (WHERE processing_status = 'RECEIVED')::int AS received,
       COUNT(*) FILTER (WHERE processing_status = 'VERIFIED')::int AS verified,
       COUNT(*) FILTER (WHERE processing_status = 'PROCESSING')::int AS processing,
       COUNT(*) FILTER (WHERE processing_status = 'PROCESSED')::int AS processed,
       COUNT(*) FILTER (WHERE processing_status = 'RETRYABLE_ERROR')::int AS retryable_errors,
       COUNT(*) FILTER (WHERE processing_status = 'TERMINAL_REJECTED')::int AS terminal_rejected,
       MIN(received_at) FILTER (
         WHERE processing_status IN ('RECEIVED', 'VERIFIED', 'RETRYABLE_ERROR', 'PROCESSING')
       ) AS oldest_unprocessed_at
     FROM sonicpesa_webhook_inbox`,
  )
  const r = rows[0] ?? {}
  const oldest = r.oldest_unprocessed_at
  const oldestAgeSec =
    oldest instanceof Date
      ? Math.max(0, Math.floor((Date.now() - oldest.getTime()) / 1000))
      : oldest
        ? Math.max(0, Math.floor((Date.now() - new Date(String(oldest)).getTime()) / 1000))
        : null
  return { ...r, oldest_unprocessed_age_sec: oldestAgeSec }
}

export function isInboxRetryExhausted(attemptCount) {
  return Number(attemptCount) >= MAX_ATTEMPTS
}
