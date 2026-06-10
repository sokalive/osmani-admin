/**
 * Aurax Pay client facade — implementation in lib/payments/providers/auraxpay.js.
 */
export {
  resolveAuraxpayCredentials,
  createOrder as auraxpayInitiatePayment,
  verifyPayment as auraxpayGetOrderStatus,
  testConnection as testAuraxpayConnection,
  normalizeResponse as normalizeAuraxpayResponse,
} from './lib/payments/providers/auraxpay.js'
