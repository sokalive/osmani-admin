import { Router } from 'express'
import { handleAuraxPayWebhook } from '../handlers/auraxPayWebhook.js'
import { handleZenoPayWebhook } from '../handlers/zenoPayWebhook.js'

export const webhooksRouter = Router()

webhooksRouter.post('/zenopay', handleZenoPayWebhook)
/** Aurax Pay callback alias (primary path remains POST /api/payments/auraxpay/webhook). */
webhooksRouter.post('/aurax', handleAuraxPayWebhook)
webhooksRouter.post('/auraxpay', handleAuraxPayWebhook)
