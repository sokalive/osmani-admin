import { Router } from 'express'
import { requireAdminPanelAccess } from '../middleware/adminPanelAuthGate.js'
import { handleAuraxpayCreateOrder } from './auraxpayPayments.js'

/** Admin-only Aurax Pay test checkout (does not require production Enable switch). */
export const adminAuraxpayPaymentsRouter = Router()

adminAuraxpayPaymentsRouter.use(requireAdminPanelAccess)

adminAuraxpayPaymentsRouter.post('/create-order', (req, res) => {
  void handleAuraxpayCreateOrder(req, res, {
    requireEnabled: false,
    context: 'admin_test_checkout',
  })
})
