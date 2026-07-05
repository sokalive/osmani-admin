/**
 * Classify and optionally reconcile stale SonicPesa pending orders (provider evidence required).
 */
import { getPool } from '../db/pool.js'
import { resolveSonicpesaCredentials, sonicpesaGetOrderStatus } from '../sonicpesaClient.js'
import { applySonicpesaPaymentOutcome, activateFromCompletedTxn, COMPLETION_SOURCE } from './canonicalPaymentActivation.js'
import * as billing from '../billingStore.js'

function redactOrderId(id) {
  const s = String(id ?? '')
  return s.length <= 14 ? s : `${s.slice(0, 10)}…${s.slice(-2)}`
}

function classifyProvider(normalized, httpOk) {
  if (!httpOk) return 'PROVIDER_LOOKUP_ERROR'
  if (!normalized) return 'PROVIDER_EVIDENCE_UNAVAILABLE'
  if (normalized.succeeded) return 'PROVIDER_SUCCESS'
  if (normalized.failed) return 'PROVIDER_FAILED'
  if (String(normalized.paymentStatus ?? '').toUpperCase() === 'PENDING') return 'PROVIDER_PENDING'
  if (!normalized.providerOrderId && !normalized.paymentStatus) return 'PROVIDER_NOT_FOUND'
  return 'PROVIDER_PENDING'
}

async function mapPool(items, fn, n) {
  const out = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()))
  return out
}

async function classifyRow(row, cred) {
  const verifyId = String(row.raw_payload?.provider_order_id ?? row.external_id ?? row.order_id).trim()
  let httpOk = false
  let normalized = null
  try {
    const z = await sonicpesaGetOrderStatus(cred, verifyId)
    httpOk = z.ok === true
    normalized = z.normalized ?? null
  } catch {
    httpOk = false
  }
  let bucket = classifyProvider(normalized, httpOk)

  if (row.status === 'completed') bucket = 'ALREADY_ENTITLED'
  const sub = row.device_id
    ? await billing.getDeviceSubscriptionAccessStateFast(String(row.device_id))
    : null
  if (sub?.active && String(sub.transaction_id ?? '') === String(row.order_id)) {
    bucket = 'ALREADY_ENTITLED'
  }
  const act = row.raw_payload?.activation_result
  if (act?.activation_state === 'PHONE_CONFLICT') bucket = 'PHONE_CONFLICT'
  if (act?.activation_state === 'MOVED_TO_SIBLING_DEVICE') bucket = 'MOVED_TO_SIBLING'

  return {
    order_id_redacted: redactOrderId(row.order_id),
    bucket,
    verify_id_redacted: redactOrderId(verifyId),
    normalized,
    row,
  }
}

export async function runStaleSonicpesaPendingReconcile({
  dryRun = true,
  limit = 50,
  staleMinutes = 30,
  concurrency = 3,
} = {}) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL required')

  const { rows } = await pool.query(
    `SELECT t.order_id, t.external_id, t.device_id, t.status, t.raw_payload, t.created_at
     FROM transactions t
     WHERE t.status = 'pending'
       AND t.created_at < now() - ($1::int || ' minutes')::interval
       AND COALESCE(t.raw_payload->>'payment_provider', '') = 'sonicpesa'
       AND COALESCE(t.order_id, '') ~ '^osm(_sp)?_'
     ORDER BY t.created_at ASC
     LIMIT $2`,
    [staleMinutes, Math.min(500, Math.max(1, Number(limit) || 50))],
  )

  const srow = await pool.query(`SELECT * FROM sonicpesa_settings WHERE id = 1`)
  const cred = resolveSonicpesaCredentials(srow.rows[0] || {})

  const counts = {
    PROVIDER_SUCCESS: 0,
    PROVIDER_FAILED: 0,
    PROVIDER_PENDING: 0,
    PROVIDER_NOT_FOUND: 0,
    PROVIDER_LOOKUP_ERROR: 0,
    PROVIDER_EVIDENCE_UNAVAILABLE: 0,
    ALREADY_ENTITLED: 0,
    MOVED_TO_SIBLING: 0,
    PHONE_CONFLICT: 0,
    UNKNOWN: 0,
  }

  const applied = { success: 0, failed: 0 }
  const samples = []

  const classified = await mapPool(
    rows,
    async (row) => {
      const c = await classifyRow(row, cred)
      counts[c.bucket] = (counts[c.bucket] ?? 0) + 1
      samples.push({ order_id_redacted: c.order_id_redacted, bucket: c.bucket })

      if (!dryRun) {
        if (c.bucket === 'PROVIDER_SUCCESS') {
          const out = await applySonicpesaPaymentOutcome({
            orderId: row.order_id,
            source: COMPLETION_SOURCE.ADMIN_RECOVERY,
            succeeded: true,
            failed: false,
            providerPayload: c.normalized?.raw ?? null,
            externalId: c.normalized?.transId ?? row.external_id,
          })
          if (out.txnStatusAfter === 'completed') applied.success += 1
        } else if (c.bucket === 'PROVIDER_FAILED') {
          await applySonicpesaPaymentOutcome({
            orderId: row.order_id,
            source: COMPLETION_SOURCE.ADMIN_RECOVERY,
            succeeded: false,
            failed: true,
            providerPayload: c.normalized?.raw ?? null,
          })
          applied.failed += 1
        }
      }
      return c
    },
    concurrency,
  )

  const intentionally_not_granted =
    (counts.PROVIDER_PENDING ?? 0) +
    (counts.PROVIDER_NOT_FOUND ?? 0) +
    (counts.PROVIDER_LOOKUP_ERROR ?? 0) +
    (counts.PROVIDER_EVIDENCE_UNAVAILABLE ?? 0) +
    (counts.UNKNOWN ?? 0) +
    (counts.PHONE_CONFLICT ?? 0) +
    (counts.MOVED_TO_SIBLING ?? 0) +
    (counts.ALREADY_ENTITLED ?? 0) +
    (dryRun ? (counts.PROVIDER_SUCCESS ?? 0) + (counts.PROVIDER_FAILED ?? 0) : 0)

  return {
    dry_run: dryRun,
    scanned: rows.length,
    stale_minutes: staleMinutes,
    counts,
    applied,
    intentionally_not_granted,
    samples: samples.slice(0, 25),
    classified_count: classified.length,
  }
}

export async function repairCriticalUnresolvedCompleted({ dryRun = false } = {}) {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL required')

  const { rows } = await pool.query(
    `SELECT c.order_id, c.device_id, c.phone, c.updated_at AS completed_at,
            ds.status AS sub_status, ds.transaction_id AS sub_txn, ds.expires_at
     FROM transactions c
     LEFT JOIN device_subscriptions ds ON ds.device_id = c.device_id
     WHERE c.status = 'completed'
       AND c.created_at >= now() - interval '90 days'
       AND COALESCE(c.order_id, '') ~ '^osm(_sp)?_'
       AND COALESCE(c.raw_payload->>'payment_provider', '') = 'sonicpesa'
       AND trim(coalesce(c.device_id, '')) <> ''
       AND (
         ds.device_id IS NULL
         OR ds.status <> 'active'
         OR ds.expires_at <= now()
         OR ds.transaction_id IS DISTINCT FROM c.order_id
       )
       AND COALESCE(ds.transaction_id::text, '') NOT LIKE 'moved:%'
       AND COALESCE(ds.transaction_id::text, '') NOT LIKE 'recovery:%'`,
  )

  const critical = rows.filter(
    (r) =>
      String(r.sub_txn ?? '') === String(r.order_id) &&
      String(r.sub_status ?? '') !== 'active',
  )

  const repairs = []
  for (const r of critical) {
    const txn = await billing.getTransactionByOrderId(r.order_id)
    const investigation = {
      order_id_redacted: redactOrderId(r.order_id),
      sub_status: r.sub_status,
      sub_txn_redacted: redactOrderId(r.sub_txn),
      expires_at: r.expires_at,
    }
    if (!dryRun && txn) {
      const pool = getPool()
      if (pool && r.order_id) {
        await pool.query(
          `UPDATE device_subscriptions SET status = 'active', updated_at = now()
           WHERE transaction_id = $1 AND status <> 'active' AND expires_at > now()`,
          [String(r.order_id)],
        )
      }
      const act = await activateFromCompletedTxn(txn, { source: COMPLETION_SOURCE.ADMIN_RECOVERY })
      investigation.repair = {
        activation_state: act.activation_state ?? act.reason,
        activated: act.activated === true,
      }
    }
    repairs.push(investigation)
  }

  return {
    dry_run: dryRun,
    broad_mismatch_count: rows.length,
    critical_count: critical.length,
    repairs,
  }
}
