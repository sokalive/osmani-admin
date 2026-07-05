/**
 * SonicPesa payment reliability observability (production-safe, redacted).
 */
import { getPool } from '../db/pool.js'
import { getInboxMetrics } from './sonicpesaWebhookInbox.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

export async function runSonicpesaReliabilityMetrics({ days = 30 } = {}) {
  const pool = requirePool()
  const windowDays = Math.min(365, Math.max(7, Number(days) || 30))

  const [{ rows: settingsRows }, { rows: staleRows }, { rows: sourceRows }, { rows: conflictRows }, inbox] =
    await Promise.all([
      pool.query(`SELECT last_webhook_at, webhook_url, environment, enabled FROM sonicpesa_settings WHERE id = 1`),
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
    ])

  const settings = settingsRows[0] ?? {}
  const lastWebhookAt = settings.last_webhook_at
  const webhookAgeSec =
    lastWebhookAt instanceof Date
      ? Math.max(0, Math.floor((Date.now() - lastWebhookAt.getTime()) / 1000))
      : lastWebhookAt
        ? Math.max(0, Math.floor((Date.now() - new Date(String(lastWebhookAt)).getTime()) / 1000))
        : null

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

  const alerts = []
  if (webhookAgeSec != null && webhookAgeSec > 3600) {
    alerts.push({ code: 'WEBHOOK_STALE_OVER_1H', webhook_age_sec: webhookAgeSec })
  }
  if (Number(inbox.retryable_errors ?? 0) > 10) {
    alerts.push({ code: 'INBOX_RETRY_BACKLOG', retryable_errors: inbox.retryable_errors })
  }
  if (Number(stale.stale_30m ?? 0) > 500) {
    alerts.push({ code: 'STALE_PENDING_SPIKE', stale_30m: stale.stale_30m })
  }

  return {
    generated_at: new Date().toISOString(),
    window_days: windowDays,
    webhook: {
      last_webhook_at:
        lastWebhookAt instanceof Date ? lastWebhookAt.toISOString() : lastWebhookAt || null,
      webhook_age_sec: webhookAgeSec,
      webhook_url_configured: Boolean(String(settings.webhook_url ?? '').trim()),
      environment: settings.environment ?? null,
      enabled: settings.enabled === true,
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
    alerts,
  }
}
