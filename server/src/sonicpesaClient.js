/**
 * SonicPesa client facade — implementation in lib/payments/providers/sonicpesa.js (ZenoPay unchanged).
 */
export {
  resolveSonicpesaCredentials,
  createOrder as sonicpesaInitiatePayment,
  verifyPayment as sonicpesaGetOrderStatus,
  testConnection as testSonicpesaConnection,
  normalizeResponse as normalizeSonicpesaResponse,
} from './lib/payments/providers/sonicpesa.js'
