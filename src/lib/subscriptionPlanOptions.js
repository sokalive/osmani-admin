import { formatTsh } from './formatMoney'

/** Legacy manual-grant durations kept for backward compatibility with older grants. */
export const MANUAL_GRANT_LEGACY_DURATION_DAYS = [1, 7, 30, 90]

/**
 * Active duration-based plans for manual grant / offer-code selectors.
 * Same catalog as GET /api/plans and subscription verify `plans` (non-deleted, active).
 */
export function filterSelectableSubscriptionPlans(plans) {
  if (!Array.isArray(plans)) return []
  return plans
    .filter((p) => p && p.isActive !== false && (p.expiryType === 'duration' || !p.expiryType))
    .sort((a, b) => Number(a.id) - Number(b.id))
}

/** Admin dropdown: plan title, duration (siku), price — aligned with mobile plan names + TSh. */
export function formatManualGrantPlanLabel(plan) {
  const name = String(plan?.name ?? '').trim() || 'Kifurushi'
  const days = Math.max(1, Math.floor(Number(plan?.durationDays) || 0))
  const duration = `${days} siku`
  return `${name} — ${duration} — ${formatTsh(plan?.price)}`
}

export function planDurationDays(plan) {
  return Math.max(1, Math.floor(Number(plan?.durationDays) || 0))
}
