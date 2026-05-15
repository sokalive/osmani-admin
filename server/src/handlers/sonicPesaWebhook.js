import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { handleWebhook as handleSonicpesaProviderWebhook } from '../lib/payments/providers/sonicpesa.js'

async function recordWebhookMeta(body) {
  try {
    await billing.recordSonicpesaWebhookReceived(body)
  } catch (e) {
    console.warn('[sonicpesa webhook] record meta failed:', e)
  }
}

/**
 * SonicPesa → POST /api/payments/sonicpesa/webhook
 */
export async function handleSonicPesaWebhook(req, res) {
  return handleSonicpesaProviderWebhook(req, res, {
    billing,
    liveSyncBus,
    deviceSubscriptionBus,
    recordWebhookMeta,
  })
}
