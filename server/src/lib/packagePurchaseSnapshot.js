/**
 * Package purchase snapshot isolation.
 *
 * CURRENT catalog = rules for NEW purchases only.
 * Historical price/duration for an existing entitlement must come from the
 * purchase/activation snapshot (transaction amount + plan_duration_days,
 * or manual grant duration), never from today's live plans row when a
 * snapshot exists.
 *
 * Live catalog is an allowed fallback ONLY when historical snapshot is absent
 * (legacy rows). It must never overwrite a valid snapshot.
 */

/**
 * @param {{
 *   txnPlanDurationDays?: unknown,
 *   grantDurationDays?: unknown,
 *   livePlanDurationDays?: unknown,
 * }} input
 * @returns {number|null}
 */
export function resolveHistoricalPlanDurationDays(input = {}) {
  const snap = Math.trunc(Number(input.txnPlanDurationDays))
  if (Number.isFinite(snap) && snap >= 1) return snap
  const grant = Math.trunc(Number(input.grantDurationDays))
  if (Number.isFinite(grant) && grant >= 1) return grant
  const live = Math.trunc(Number(input.livePlanDurationDays))
  if (Number.isFinite(live) && live >= 1) return live
  return null
}

/**
 * Historical paid amount: transaction amount first; live catalog price only if missing.
 * @param {{ txnAmount?: unknown, livePlanPrice?: unknown }} input
 * @returns {number|null}
 */
export function resolveHistoricalPaidAmount(input = {}) {
  if (input.txnAmount != null && input.txnAmount !== '') {
    const n = Number(input.txnAmount)
    if (Number.isFinite(n)) return n
  }
  if (input.livePlanPrice != null && input.livePlanPrice !== '') {
    const n = Number(input.livePlanPrice)
    if (Number.isFinite(n)) return n
  }
  return null
}

/**
 * Prove catalog mutation does not change an already-captured historical snapshot.
 * Pure function for regression tests — no DB.
 *
 * @param {{ amount: number, durationDays: number }} purchaseSnapshot
 * @param {{ price: number, durationDays: number }} catalogAfterChange
 */
export function assertPurchaseIsolatedFromCatalog(purchaseSnapshot, catalogAfterChange) {
  const amount = resolveHistoricalPaidAmount({
    txnAmount: purchaseSnapshot.amount,
    livePlanPrice: catalogAfterChange.price,
  })
  const duration = resolveHistoricalPlanDurationDays({
    txnPlanDurationDays: purchaseSnapshot.durationDays,
    livePlanDurationDays: catalogAfterChange.durationDays,
  })
  return {
    amount,
    durationDays: duration,
    isolated:
      amount === Number(purchaseSnapshot.amount) &&
      duration === Math.trunc(Number(purchaseSnapshot.durationDays)),
  }
}

/**
 * New purchase after catalog change uses the NEW catalog (simulated snapshot at buy time).
 */
export function snapshotFromCurrentCatalog(catalog) {
  return {
    amount: Number(catalog.price),
    durationDays: Math.trunc(Number(catalog.durationDays)),
  }
}

/**
 * SQL: historical duration for entitlement-linked payment + optional manual grant.
 * Prefer txn snapshot → grant duration → live catalog (legacy only).
 * @param {string} [payAlias='pay']
 * @param {string} [mgAlias='mg']
 * @param {string} [planAlias='p']
 */
export function historicalPlanDurationSql(payAlias = 'pay', mgAlias = 'mg', planAlias = 'p') {
  return `COALESCE(
    NULLIF(${payAlias}.plan_duration_days, 0),
    ${mgAlias}.duration_days,
    ${planAlias}.duration_days
  )`
}

/**
 * SQL: historical duration for a transaction row joined to plans.
 * @param {string} [txnAlias='t']
 * @param {string} [planAlias='p']
 */
export function historicalTxnPlanDurationSql(txnAlias = 't', planAlias = 'p') {
  return `COALESCE(NULLIF(${txnAlias}.plan_duration_days, 0), ${planAlias}.duration_days)`
}

/**
 * SQL: historical paid amount.
 */
export function historicalPaidAmountSql(payAlias = 'pay', planAlias = 'p') {
  return `COALESCE(${payAlias}.amount, ${planAlias}.price)`
}
