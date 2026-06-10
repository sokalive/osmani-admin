import * as billing from '../billingStore.js'
import { deviceSubscriptionBus } from '../lib/deviceSubscriptionBus.js'
import { liveSyncBus } from '../lib/liveSyncBus.js'
import { handleWebhook as handleAuraxpayProviderWebhook } from '../lib/payments/providers/auraxpay.js'

async function recordWebhookMeta(body) {
  try {
    await billing.recordAuraxpayWebhookReceived(body)
  } catch (e) {
    console.warn('[auraxpay webhook] record meta failed:', e)
  }
}

/** Aurax Pay → POST /api/payments/auraxpay/webhook */
export async function handleAuraxPayWebhook(req, res) {
  return handleAuraxpayProviderWebhook(req, res, {
    billing,
    liveSyncBus,
    deviceSubscriptionBus,
    recordWebhookMeta,
  })
}
