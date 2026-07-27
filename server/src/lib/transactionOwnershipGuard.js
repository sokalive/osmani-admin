/**
 * Transactions are permanently READ-ONLY for subscription ownership.
 *
 * Canonical ownership flow (only):
 *   Device ID → device_subscriptions (canonical entitlement) → linked txn (metadata)
 *
 * Forbidden:
 *   Phone / latest payment / ORDER BY created_at → current owner
 *
 * Transactions remain valid for audit, receipts, reconciliation, analytics,
 * and metadata AFTER entitlement is already resolved by device_id.
 */
import { CANONICAL_ENGINE_VERSION } from './subscriptionHardeningConstants.js'

export const TRANSACTIONS_OWNERSHIP_POLICY = 'transactions_read_only_for_ownership'
export const TRANSACTIONS_OWNERSHIP_REFUSED = 'TRANSACTIONS_READ_ONLY_FOR_OWNERSHIP'

export class TransactionsOwnershipError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'TransactionsOwnershipError'
    this.code = TRANSACTIONS_OWNERSHIP_REFUSED
    this.detail = detail
  }
}

/**
 * Hard refuse any attempt to derive current entitlement ownership from transaction history.
 * Call at the top of helpers that would otherwise phone→latest-txn → owner.
 */
export function refuseTransactionHistoryOwnership(surface, detail = '') {
  const msg =
    `[${TRANSACTIONS_OWNERSHIP_REFUSED}] Refused ownership via transaction history` +
    ` (surface=${surface}, engine=${CANONICAL_ENGINE_VERSION}).` +
    ` Canonical SoT is device_subscriptions by device_id.` +
    (detail ? ` ${detail}` : '')
  console.error('[txn-ownership-guard]', msg)
  throw new TransactionsOwnershipError(msg, { surface, detail })
}

/** Surfaces that must never return an owner from payment history alone. */
export const FORBIDDEN_OWNERSHIP_SURFACES = Object.freeze({
  LATEST_TXN_BY_PHONE: 'getLatestCompletedTransactionByNormalizedPhone',
  PHONE_LATEST_PAYMENT_OWNER: 'phone_latest_payment_owner',
  TXN_ORDER_BY_CREATED_OWNER: 'transactions_order_by_created_at_owner',
})
