/**
 * SonicPesa payment reliability observability (production-safe, redacted).
 */
import { getPool } from '../db/pool.js'
import { getInboxMetrics } from './sonicpesaWebhookInbox.js'
import { getSonicpesaWebhookHealthSnapshot } from './sonicpesaWebhookHealth.js'
import { getReconciliationQueueMetrics } from './sonicpesaPaymentReconciliationQueue.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

export async function runSonicpesaReliabilityMetrics({ days = 30 } = {}) {
  const pool = requirePool()
  const windowDays = Math.min(365, Math.max(7, Number(days) || 30))

  const [{ rows: settingsRows }, { rows: staleRows }, { rows: sourceRows }, { rows: conflictRows }, inbox, webhookHealth, reconcileQueue] =
    await Promise.all([
      pool.query(`SELECT last_webhook_at, last_provider_webhook_at, webhook_url, environment, enabled FROM sonicpesa_settings WHERE id = 1`),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '5 minutes')::int AS stale_5m,
           COUNT(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '15 minutes')::int AS stale_15m,
           COUNT(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '30 minutes')::int AS stale_30m,
           COUNT(*) FILTER (WHERE status = 'pending' AND created_at < now() - interval '2 hours')::int AS stale_2h
         FROM transactions
         WHERE created_at >= now() - ($1::int || ' days')::interval
           AND COALESCE(raw_payload->>'payment_provider', '') = 'sonicpesa'
           AND COALESCE(order_id, '') ~ '^osm(_sp)?_'`,
        [windowDays],
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (WHERE raw_payload ? 'sonic_webhook')::int AS sonic_webhook,
           COUNT(*) FILTER (WHERE raw_payload ? 'order_status_poll')::int AS order_status_poll,
           COUNT(*) FILTER (
             WHERE status = 'completed'
               AND NOT (raw_payload ? 'sonic_webhook')
               AND NOT (raw_payload ? 'order_status_poll')
           )::int AS other_completion
         FROM transactions
         WHERE status = 'completed'
           AND created_at >= now() - ($1::int || ' days')::interval
           AND COALESCE(raw_payload->>'payment_provider', '') = 'sonicpesa'`,
        [windowDays],
      ),
      pool.query(
        `SELECT
           COUNT(*) FILTER (
             WHERE raw_payload->'activation_result'->>'activation_state' = 'PHONE_CONFLICT'
           )::int AS phone_conflict,
           COUNT(*) FILTER (
             WHERE raw_payload->'activation_result'->>'activation_state' = 'MOVED_TO_SIBLING_DEVICE'
           )::int AS moved_sibling
         FROM transactions
         WHERE created_at >= now() - ($1::int || ' days')::interval
           AND COALESCE(raw_payload->>'payment_provider', '') = 'sonicpesa'`,
        [windowDays],
      ),
      getInboxMetrics(),
      getSonicpesaWebhookHealthSnapshot(),
      getReconciliationQueueMetrics(),
    ])

  const settings = settingsRows[0] ?? {}
  const lastProviderWebhookAt = settings.last_provider_webhook_at ?? webhookHealth?.last_provider_webhook_at
  const webhookAgeSec = webhookHealth?.provider_webhook_age_sec ?? null

  const { rows: latencyRows } = await pool.query(
    `SELECT
       percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ds.updated_at - t.updated_at))) AS p50_sec,
       percentile_cont(0.9) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ds.updated_at - t.updated_at))) AS p90_sec,
       percentile_cont(0.95) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ds.updated_at - t.updated_at))) AS p95_sec,
       percentile_cont(0.99) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (ds.updated_at - t.updated_at))) AS p99_sec
     FROM transactions t
     INNER JOIN device_subscriptions ds ON ds.device_id = t.device_id AND ds.transaction_id = t.order_id
     WHERE t.status = 'completed'
       AND t.created_at >= now() - ($1::int || ' days')::interval
       AND COALESCE(t.raw_payload->>'payment_provider', '') = 'sonicpesa'
       AND ds.status = 'active'
       AND ds.expires_at > now()`,
    [windowDays],
  )

  const latency = latencyRows[0] ?? {}
  const stale = staleRows[0] ?? {}
  const sources = sourceRows[0] ?? {}
  const conflicts = conflictRows[0] ?? {}

  const alerts = [...(webhookHealth?.alerts ?? [])]
  if (Number(inbox.retryable_errors ?? 0) > 10) {
    alerts.push({ code: 'INBOX_RETRY_BACKLOG', retryable_errors: inbox.retryable_errors })
  }
  if (Number(stale.stale_30m ?? 0) > 500) {
    alerts.push({ code: 'PENDING_OVER_30M_HIGH', stale_30m: stale.stale_30m })
  }
  const { rows: criticalRows } = await pool.query(
    `SELECT COUNT(*)::int AS critical_unresolved
     FROM transactions c
     LEFT JOIN device_subscriptions ds ON ds.device_id = c.device_id
     WHERE c.status = 'completed'
       AND c.created_at >= now() - ($1::int || ' days')::interval
       AND COALESCE(c.order_id, '') ~ '^osm(_sp)?_'
       AND COALESCE(c.raw_payload->>'payment_provider', '') = 'sonicpesa'
       AND trim(coalesce(c.device_id, '')) <> ''
       AND ds.transaction_id = c.order_id
       AND ds.status <> 'active'
       AND COALESCE(ds.transaction_id::text, '') NOT LIKE 'moved:%'
       AND COALESCE(ds.transaction_id::text, '') NOT LIKE 'recovery:%'`,
    [windowDays],
  )
  const criticalUnresolved = Number(criticalRows[0]?.critical_unresolved ?? 0)
  if (criticalUnresolved > 0) {
    alerts.push({ code: 'CRITICAL_UNRESOLVED_GT_0', count: criticalUnresolved })
  }

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    webhook: {
      ...webhookHealth,
      last_provider_webhook_at:
        lastProviderWebhookAt instanceof Date
          ? lastProviderWebhookAt.toISOString()
          : lastProviderWebhookAt || null,
      provider_webhook_age_sec: webhookAgeSec,
    },
    stale_pending: stale,
    completion_sources: sources,
    conflicts,
    activation_latency_sec: {
      p50: latency.p50_sec != null ? Number(latency.p50_sec) : null,
      p90: latency.p90_sec != null ? Number(latency.p90_sec) : null,
      p95: latency.p95_sec != null ? Number(latency.p95_sec) : null,
      p99: latency.p99_sec != null ? Number(latency.p99_sec) : null,
    },
    inbox,
    reconciliation_queue: reconcileQueue,
    critical_unresolved_completed: criticalUnresolved,
    alerts,
  }
}
