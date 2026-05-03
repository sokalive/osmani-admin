import { isSameLocalDay } from './dates'

/** Daily completed revenue for the last `days` ending today (local), from real transactions. */
export function buildRevenueSeriesFromTransactions(transactions, days) {
  const now = new Date()
  const out = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now)
    d.setDate(d.getDate() - i)
    d.setHours(12, 0, 0, 0)
    let revenue = 0
    for (const t of transactions || []) {
      if (t.status !== 'completed') continue
      if (!isSameLocalDay(t.date, d)) continue
      revenue += Number(t.amount) || 0
    }
    const label =
      days > 14
        ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
        : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
    out.push({ label, date: d.toISOString(), revenue: Math.round(revenue) })
  }
  return out
}

/** Rank “content” by completed transaction volume (plan name as proxy). */
export function topWatchedFromTransactions(transactions, limit = 8) {
  const m = new Map()
  for (const t of transactions || []) {
    if (t.status !== 'completed') continue
    const title = t.plan || 'Other'
    m.set(title, (m.get(title) || 0) + (Number(t.amount) || 0))
  }
  const arr = [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  if (arr.length === 0) return []
  const max = arr[0][1] || 1
  return arr.map(([title, views], i) => ({
    id: `tx-top-${i}`,
    title,
    views: Math.round(views),
    bar: Math.round((views / max) * 100),
  }))
}

/** Sum completed transaction amounts for local calendar “today”. */
export function revenueTodayFromTransactions(transactions) {
  const day = new Date()
  let sum = 0
  for (const t of transactions) {
    if (t.status !== 'completed') continue
    if (!isSameLocalDay(t.date, day)) continue
    const a = Number(t.amount)
    if (Number.isFinite(a)) sum += a
  }
  return sum
}
