/**
 * Durable "this payment already produced its one entitlement window".
 *
 * Consumption is NOT "the subscription is currently unexpired".
 * A completed order that has already been written onto a device stays consumed
 * after that window expires. A different order id is a new payment and may activate.
 */

const MS_TOLERANCE = 2 * 60 * 1000

/**
 * @param {{
 *   orderId?: string,
 *   linkedTransactionId?: string|null,
 *   entitlementConsumedAt?: string|null,
 * }} evidence
 */
export function isTransactionEntitlementConsumed(evidence = {}) {
  const orderId = String(evidence.orderId ?? '').trim()
  if (!orderId) return false
  const consumedAt = evidence.entitlementConsumedAt
  if (consumedAt != null && String(consumedAt).trim() !== '') return true
  const linked = String(evidence.linkedTransactionId ?? '').trim()
  return linked.length > 0 && linked === orderId
}

/**
 * In-memory activator used to prove the consumption contract, including races.
 * Production uses the same predicate against PostgreSQL, keyed by order id.
 */
export function createConsumedOrderActivator() {
  /** @type {Map<string, { windows: number, startedAt: string, expiresAt: string }>} */
  const consumed = new Map()
  /** @type {Map<string, Promise<void>>} */
  const locks = new Map()

  async function withLock(orderId, fn) {
    const prev = locks.get(orderId) ?? Promise.resolve()
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    locks.set(
      orderId,
      prev.then(() => gate),
    )
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }

  return {
    async activate(orderId, { startedAt, expiresAt }) {
      const oid = String(orderId ?? '').trim()
      return withLock(oid, async () => {
        const row = consumed.get(oid)
        if (
          isTransactionEntitlementConsumed({
            orderId: oid,
            linkedTransactionId: row ? oid : null,
            entitlementConsumedAt: row ? row.startedAt : null,
          })
        ) {
          return { activated: false, skipped: true, reason: 'already_consumed', windows: row.windows }
        }
        consumed.set(oid, { windows: 1, startedAt, expiresAt })
        return { activated: true, skipped: false, reason: 'ok', windows: 1, startedAt, expiresAt }
      })
    },
    get(orderId) {
      return consumed.get(String(orderId ?? '').trim()) ?? null
    },
  }
}

export function orderIdsAreDistinct(a, b) {
  const left = String(a ?? '').trim()
  const right = String(b ?? '').trim()
  return Boolean(left && right && left !== right)
}

/**
 * A later started_at must not be treated as the first credit clock when it
 * falls after the window already implied by this payment's own credit time.
 * Delayed first activations (credit still inside the window) may still align.
 * @param {number} creditMs
 * @param {number} startedMs
 * @param {string} impliedExpiryIso midnight EAT expiry from creditMs
 */
export function shouldRefuseCreditAlignmentToStartedAt(creditMs, startedMs, impliedExpiryIso) {
  if (!Number.isFinite(creditMs) || !Number.isFinite(startedMs)) return false
  const expiryMs = Date.parse(String(impliedExpiryIso ?? ''))
  if (!Number.isFinite(expiryMs)) return false
  return startedMs > expiryMs + MS_TOLERANCE
}
