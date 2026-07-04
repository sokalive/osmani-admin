/**
 * Production payment pipeline audit (read-only SQL evidence, last 90 days).
 */
import { getPool } from '../db/pool.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

const PAYMENT_ORDER_RE = '^osm(_sp)?_'

export async function runPaymentProductionAudit({ days = 90 } = {}) {
  const pool = requirePool()
  const windowDays = Math.min(365, Math.max(7, Number(days) || 90))

  const { rows: summary } = await pool.query(
    `WITH window_txn AS (
       SELECT t.*
       FROM transactions t
       WHERE t.created_at >= now() - ($1::int || ' days')::interval
         AND COALESCE(t.order_id, '') ~ $2
     ),
     completed AS (
       SELECT * FROM window_txn WHERE status = 'completed'
     ),
     completed_no_active AS (
       SELECT c.order_id, c.device_id, c.phone, c.updated_at
       FROM completed c
       LEFT JOIN device_subscriptions ds ON ds.device_id = c.device_id
       WHERE trim(coalesce(c.device_id, '')) <> ''
         AND (
           ds.device_id IS NULL
           OR ds.status <> 'active'
           OR ds.expires_at <= now()
           OR ds.transaction_id IS DISTINCT FROM c.order_id
         )
     ),
     pending_stale AS (
       SELECT p.order_id, p.device_id, p.phone, p.created_at, p.updated_at
       FROM window_txn p
       WHERE p.status = 'pending'
         AND p.created_at < now() - interval '30 minutes'
     ),
     activation_delay AS (
       SELECT c.order_id, c.device_id
       FROM completed c
       INNER JOIN device_subscriptions ds
         ON ds.device_id = c.device_id AND ds.transaction_id = c.order_id
       WHERE ds.status = 'active'
         AND ds.expires_at > now()
         AND ds.updated_at > c.updated_at + interval '5 seconds'
     )
     SELECT
       (SELECT COUNT(*)::int FROM window_txn) AS payment_txns_total,
       (SELECT COUNT(*)::int FROM completed) AS completed_count,
       (SELECT COUNT(*)::int FROM window_txn WHERE status = 'pending') AS pending_count,
       (SELECT COUNT(*)::int FROM window_txn WHERE status = 'failed') AS failed_count,
       (SELECT COUNT(*)::int FROM completed_no_active) AS completed_without_active_match,
       (SELECT COUNT(*)::int FROM pending_stale) AS pending_older_than_30m,
       (SELECT COUNT(*)::int FROM activation_delay) AS activation_delayed_over_5s,
       (SELECT COUNT(*)::int FROM device_subscriptions WHERE status = 'active' AND expires_at > now()) AS active_subscriptions_now`,
    [windowDays, PAYMENT_ORDER_RE],
  )

  const { rows: sampleNoActive } = await pool.query(
    `SELECT c.order_id, c.device_id, c.phone, c.updated_at AS completed_at,
            ds.status AS sub_status, ds.transaction_id AS sub_txn, ds.expires_at
     FROM transactions c
     LEFT JOIN device_subscriptions ds ON ds.device_id = c.device_id
     WHERE c.status = 'completed'
       AND c.created_at >= now() - ($1::int || ' days')::interval
       AND COALESCE(c.order_id, '') ~ $2
       AND trim(coalesce(c.device_id, '')) <> ''
       AND (
         ds.device_id IS NULL
         OR ds.status <> 'active'
         OR ds.expires_at <= now()
         OR ds.transaction_id IS DISTINCT FROM c.order_id
       )
     ORDER BY c.updated_at DESC
     LIMIT 25`,
    [windowDays, PAYMENT_ORDER_RE],
  )

  const s = summary[0] ?? {}
  const critical =
    Number(s.completed_without_active_match ?? 0) > 0
      ? sampleNoActive.filter(
          (r) =>
            String(r.sub_txn ?? '').startsWith('moved:') === false &&
            String(r.sub_txn ?? '').startsWith('recovery:') === false &&
            String(r.sub_status ?? '') !== 'active',
        ).length
      : 0

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    verdict: critical === 0 ? 'NO_BUG_FOUND' : 'ISSUES_DETECTED',
    counts: s,
    critical_unresolved_completed: critical,
    sample_completed_without_active: sampleNoActive,
  }
}
