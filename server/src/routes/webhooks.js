import { Router } from 'express'
import { handleZenoPayWebhook } from '../handlers/zenoPayWebhook.js'

export const webhooksRouter = Router()

webhooksRouter.post('/zenopay', handleZenoPayWebhook)
