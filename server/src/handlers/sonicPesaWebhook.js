import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { handleWebhook as handleSonicpesaProviderWebhook } from '../lib/payments/providers/sonicpesa.js'

async function recordWebhookMeta(req, body) {
  try {
    const { isEngineeringWebhookProbe, recordSonicpesaWebhookHealthEvent } =
      await import('../lib/sonicpesaWebhookHealth.js')
    const o = body && typeof body === 'object' ? body : {}
    const engineeringProbe = isEngineeringWebhookProbe(req, body)
    await recordSonicpesaWebhookHealthEvent({
      kind: engineeringProbe ? 'engineering_probe' : 'provider_webhook',
      orderId: String(o.order_id ?? o.orderId ?? o.merchant_order_id ?? ''),
      event: String(o.event ?? o.type ?? ''),
    })
    await billing.recordSonicpesaWebhookReceived(body, { engineeringProbe })
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
