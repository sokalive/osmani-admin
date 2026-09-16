/**
 * Authoritative payment credit-clock helpers.
 *
 * A completed payment's credit time must NEVER fall back to a stale order
 * created_at when later completion / activation evidence exists.
 *
 * Known bulk backfill stamp (must not be treated as payment completion):
 * 2026-07-26T19:53:34.846Z
 */

/** Migration batch that bulk-touched transactions.updated_at — never use as credit time. */
export const TRANSACTION_BULK_BACKFILL_AT_ISO = '2026-07-26T19:53:34.846Z'

/**
 * SQL expression for authoritative payment credit timestamp.
 * Prefer completed_at → webhook/poll stamps → safe updated_at → created_at.
 * @param {string} [alias='t']
 */
export function transactionCreditAtSql(alias = 't') {
  const a = String(alias || 't').replace(/[^a-zA-Z0-9_]/g, '') || 't'
  return `COALESCE(
    ${a}.completed_at,
    NULLIF(trim(${a}.raw_payload->>'webhookAt'), '')::timestamptz,
    NULLIF(trim(${a}.raw_payload->>'orderStatusPolledAt'), '')::timestamptz,
    CASE
      WHEN ${a}.status = 'completed'
        AND ${a}.updated_at IS NOT NULL
        AND ABS(EXTRACT(EPOCH FROM (${a}.updated_at - TIMESTAMPTZ '${TRANSACTION_BULK_BACKFILL_AT_ISO}'))) > 2
        AND ${a}.updated_at > ${a}.created_at + INTERVAL '2 minutes'
      THEN ${a}.updated_at
      ELSE NULL
    END,
    ${a}.created_at
  )`
}

/**
 * Pure JS resolver mirroring {@link transactionCreditAtSql} (for unit tests).
 * @param {{
 *   completed_at?: string|Date|null,
 *   created_at?: string|Date|null,
 *   updated_at?: string|Date|null,
 *   status?: string|null,
 *   raw_payload?: Record<string, unknown>|null,
 * }} txn
 * @returns {number|null} epoch ms
 */
export function resolveTransactionCreditAtMs(txn) {
  const toMs = (v) => {
    if (v == null || v === '') return null
    const d = v instanceof Date ? v : new Date(v)
    const ms = d.getTime()
    return Number.isFinite(ms) ? ms : null
  }
  const completed = toMs(txn?.completed_at)
  if (completed != null) return completed

  const raw = txn?.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  const webhook = toMs(raw.webhookAt)
  if (webhook != null) return webhook
  const polled = toMs(raw.orderStatusPolledAt)
  if (polled != null) return polled

  const updated = toMs(txn?.updated_at)
  const created = toMs(txn?.created_at)
  const bulkMs = Date.parse(TRANSACTION_BULK_BACKFILL_AT_ISO)
  if (
    String(txn?.status ?? '').trim() === 'completed' &&
    updated != null &&
    created != null &&
    Math.abs(updated - bulkMs) > 2000 &&
    updated > created + 2 * 60 * 1000
  ) {
    return updated
  }
  return created
}

/**
 * SQL CASE fragment: when transitioning to completed, stamp completed_at once.
 * Idempotent — never moves an existing completed_at.
 * @param {string} statusExpr SQL expression for the new status value
 */
export function completedAtPersistSql(statusExpr = `COALESCE($2, status)`) {
  return `CASE
    WHEN (${statusExpr}) = 'completed' THEN COALESCE(completed_at, now())
    ELSE completed_at
  END`
}
