/**
 * Authoritative Aurax Pay production webhook URL — always VPS, never Render.
 * Mirrors sonicpesaWebhookConfig.js (SonicPesa already cut over).
 */
import { defaultPublicApiOrigin } from './deployMeta.js'

const CANONICAL_VPS_WEBHOOK = 'https://api.osmanitv.com/api/payments/auraxpay/webhook'

/** Production callback Aurax Pay dashboard / create-order payloads must target. */
export function canonicalAuraxpayProductionWebhookUrl() {
  const envOverride = String(process.env.AURAXPAY_PRODUCTION_WEBHOOK_URL || '').trim()
  if (envOverride && !isLegacyRenderWebhookUrl(envOverride)) {
    const cleaned = envOverride.replace(/\/+$/, '')
    return cleaned.includes('/api/payments/auraxpay/webhook')
      ? cleaned
      : `${cleaned}/api/payments/auraxpay/webhook`
  }
  const base = defaultPublicApiOrigin().replace(/\/+$/, '')
  if (base.includes('onrender.com')) return CANONICAL_VPS_WEBHOOK
  return `${base}/api/payments/auraxpay/webhook`
}

export function isLegacyRenderWebhookUrl(url) {
  const u = String(url ?? '').trim().toLowerCase()
  if (!u) return false
  return u.includes('onrender.com') || u.includes('osmani-admin-api.onrender')
}

/** Normalize stored/env webhook URLs — replace legacy Render with authoritative VPS. */
export function normalizeStoredAuraxpayWebhookUrl(url) {
  const raw = String(url ?? '').trim()
  if (!raw || isLegacyRenderWebhookUrl(raw)) {
    return canonicalAuraxpayProductionWebhookUrl()
  }
  return raw
}
