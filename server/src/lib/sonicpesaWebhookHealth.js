/**
 * Distinguish provider webhooks from engineering probes; track health clocks separately.
 */
import { getPool } from '../db/pool.js'
import { canonicalSonicpesaProductionWebhookUrl } from './sonicpesaWebhookConfig.js'

export function isEngineeringWebhookProbe(req, body) {
  const hdr = String(req?.headers?.['x-osmani-engineering-probe'] ?? '').trim().toLowerCase()
  if (hdr === '1' || hdr === 'true' || hdr === 'yes') return true
  const o = body && typeof body === 'object' ? body : {}
  if (o.synthetic_fixture === true || o.engineering_probe === true) return true
  const oid = String(o.order_id ?? o.merchant_order_id ?? '').trim()
  if (/^(synthetic_|probe_|inbox_test_)/i.test(oid)) return true
  return false
}

export function webhookSecretConfigured() {
  return Boolean(String(process.env.SONICPESA_WEBHOOK_SECRET ?? '').trim())
}

export async function recordSonicpesaWebhookHealthEvent({
  kind,
  orderId = '',
  event = '',
  signatureValid = null,
}) {
  const pool = getPool()
  if (!pool) return
  const oid = String(orderId ?? '').slice(0, 128)
  const ev = String(event ?? '').slice(0, 128)

  if (kind === 'engineering_probe') {
    await pool.query(
      `UPDATE sonicpesa_settings SET
         last_engineering_probe_at = now(),
         last_webhook_order_id = COALESCE(NULLIF($1, ''), last_webhook_order_id),
         updated_at = now()
       WHERE id = 1`,
      [oid],
    )
    return
  }

  if (kind === 'invalid_signature') {
    await pool.query(
      `UPDATE sonicpesa_settings SET
         last_invalid_signature_at = now(),
         updated_at = now()
       WHERE id = 1`,
      [],
    )
    return
  }

  if (kind === 'provider_webhook') {
    await pool.query(
      `UPDATE sonicpesa_settings SET
         last_provider_webhook_at = now(),
         last_webhook_at = now(),
         last_webhook_event = $1,
         last_webhook_order_id = $2,
         updated_at = now()
       WHERE id = 1`,
      [ev, oid],
    )
  }
}

export async function getSonicpesaWebhookHealthSnapshot() {
  const pool = getPool()
  if (!pool) return null
  const { rows } = await pool.query(
    `SELECT
       last_webhook_at,
       last_provider_webhook_at,
       last_engineering_probe_at,
       last_invalid_signature_at,
       webhook_url,
       environment,
       enabled
     FROM sonicpesa_settings WHERE id = 1`,
  )
  const r = rows[0] ?? {}
  const ageSec = (ts) => {
    if (!ts) return null
    const d = ts instanceof Date ? ts : new Date(String(ts))
    return Number.isFinite(d.getTime()) ? Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000)) : null
  }
  const providerAge = ageSec(r.last_provider_webhook_at)
  const alerts = []
  if (providerAge != null && providerAge > 900) alerts.push({ code: 'PROVIDER_WEBHOOK_STALE_15M', age_sec: providerAge })
  if (providerAge != null && providerAge > 3600) alerts.push({ code: 'PROVIDER_WEBHOOK_STALE_1H', age_sec: providerAge })
  if (providerAge != null && providerAge > 21600) alerts.push({ code: 'PROVIDER_WEBHOOK_STALE_6H', age_sec: providerAge })
  return {
    webhook_secret_configured: webhookSecretConfigured(),
    callback_url: canonicalSonicpesaProductionWebhookUrl(),
    signature_header: 'X-SonicPesa-Signature',
    signature_algorithm: 'HMAC-SHA256 (hex digest of raw POST body bytes)',
    expected_event: 'payment.completed',
    expected_success_status: 'SUCCESS',
    owner_dashboard_action_required: 'Configure webhook endpoint URL in SonicPesa dashboard (was: NO ENDPOINT CONFIGURED)',
    last_provider_webhook_at: r.last_provider_webhook_at ?? null,
    last_engineering_probe_at: r.last_engineering_probe_at ?? null,
    last_invalid_signature_at: r.last_invalid_signature_at ?? null,
    last_webhook_at_legacy: r.last_webhook_at ?? null,
    provider_webhook_age_sec: providerAge,
    engineering_probe_age_sec: ageSec(r.last_engineering_probe_at),
    webhook_url_configured: Boolean(String(r.webhook_url ?? '').trim()),
    environment: r.environment ?? null,
    enabled: r.enabled === true,
    alerts,
  }
}
