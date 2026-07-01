/** Stable merge + fingerprint helpers for admin Users table background refresh. */

export function userRowKey(row, tab = 'all') {
  if (tab === 'failed') {
    return String(row?.order_id || `${row?.device_id}-${row?.created_at}`)
  }
  return String(row?.device_id ?? '')
}

const SUB_FIELDS = [
  'device_id',
  'phone_number',
  'plan_id',
  'plan_name',
  'amount',
  'started_at',
  'expires_at',
  'status',
  'provider',
  'source',
]

const FAILED_FIELDS = [
  'order_id',
  'device_id',
  'phone_number',
  'plan_id',
  'plan_name',
  'amount',
  'provider',
  'failure_reason',
  'created_at',
  'last_status',
  'retry_hint',
]

export function fingerprintUserRow(row, tab = 'all') {
  const fields = tab === 'failed' ? FAILED_FIELDS : SUB_FIELDS
  return fields.map((f) => `${f}:${row?.[f] ?? ''}`).join('|')
}

export function fingerprintUserRows(rows, tab = 'all') {
  if (!Array.isArray(rows)) return ''
  return rows.map((r) => fingerprintUserRow(r, tab)).join('\n')
}

export function fingerprintPagination(pagination) {
  if (!pagination) return ''
  return `${pagination.page}|${pagination.total}|${pagination.totalPages}|${pagination.limit}`
}

export function fingerprintSummary(summary) {
  if (!summary || typeof summary !== 'object') return ''
  return [
    'active_paid',
    'expiring_24h',
    'expiring_3d',
    'expiring_7d',
    'failed_payments',
    'all_subscriptions',
  ]
    .map((k) => `${k}:${summary[k] ?? ''}`)
    .join('|')
}

/**
 * Merge fetched rows into current page by key — updates changed rows in place, preserves order from server.
 * If server returns fewer rows on same page (edge), use server list as source of truth.
 */
export function mergeUserRows(prev, next, tab = 'all') {
  if (!Array.isArray(next) || next.length === 0) {
    return Array.isArray(prev) ? prev : []
  }
  if (!Array.isArray(prev) || prev.length === 0) return next

  const prevByKey = new Map(prev.map((r) => [userRowKey(r, tab), r]))
  let anyChange = prev.length !== next.length

  const merged = next.map((row) => {
    const key = userRowKey(row, tab)
    const old = prevByKey.get(key)
    if (!old) {
      anyChange = true
      return row
    }
    const fpOld = fingerprintUserRow(old, tab)
    const fpNew = fingerprintUserRow(row, tab)
    if (fpOld !== fpNew) anyChange = true
    return fpOld === fpNew ? old : row
  })

  if (!anyChange && fingerprintUserRows(prev, tab) === fingerprintUserRows(merged, tab)) {
    return prev
  }
  return merged
}

export function shouldApplyTabFetch(prev, next, tab) {
  const rowsChanged = fingerprintUserRows(prev.items, tab) !== fingerprintUserRows(next.items, tab)
  const paginationChanged =
    fingerprintPagination(prev.pagination) !== fingerprintPagination(next.pagination)
  return rowsChanged || paginationChanged
}
