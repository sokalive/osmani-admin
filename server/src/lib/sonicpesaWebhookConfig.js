/**
 * Authoritative SonicPesa production webhook URL — always VPS, never Render.
 */
import { defaultPublicApiOrigin } from './deployMeta.js'

const CANONICAL_VPS_WEBHOOK =
  'https://api.osmanitv.com/api/payments/sonicpesa/webhook'

/** Production callback SonicPesa dashboard must target. */
export function canonicalSonicpesaProductionWebhookUrl() {
  const envOverride = String(process.env.SONICPESA_PRODUCTION_WEBHOOK_URL || '').trim()
  if (envOverride && !isLegacyRenderWebhookUrl(envOverride)) {
    return envOverride.replace(/\/+$/, '').includes('/api/payments/sonicpesa/webhook')
      ? envOverride.replace(/\/+$/, '')
      : `${envOverride.replace(/\/+$/, '')}/api/payments/sonicpesa/webhook`
  }
  const base = defaultPublicApiOrigin().replace(/\/+$/, '')
  if (base.includes('onrender.com')) return CANONICAL_VPS_WEBHOOK
  return `${base}/api/payments/sonicpesa/webhook`
}

export function isLegacyRenderWebhookUrl(url) {
  const u = String(url ?? '').trim().toLowerCase()
  if (!u) return false
  return u.includes('onrender.com') || u.includes('osmani-admin-api.onrender')
}

/** Normalize stored/env webhook URLs — replace legacy Render with authoritative VPS. */
export function normalizeStoredSonicpesaWebhookUrl(url) {
  const raw = String(url ?? '').trim()
  if (!raw || isLegacyRenderWebhookUrl(raw)) {
    return canonicalSonicpesaProductionWebhookUrl()
  }
  return raw
}
