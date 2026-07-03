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

/** Order-independent fingerprint — ignores row reordering from server sort. */
export function fingerprintUserRowsContent(rows, tab = 'all') {
  if (!Array.isArray(rows)) return ''
  return rows
    .map((r) => fingerprintUserRow(r, tab))
    .sort()
    .join('\n')
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
 * Merge fetched rows into current page by key.
 * On silent refresh with the same key set, preserve client row order to prevent jumpiness.
 */
export function mergeUserRows(prev, next, tab = 'all', { silent = false } = {}) {
  if (!Array.isArray(next) || next.length === 0) {
    return Array.isArray(prev) ? prev : []
  }
  if (!Array.isArray(prev) || prev.length === 0) return next

  const prevByKey = new Map(prev.map((r) => [userRowKey(r, tab), r]))
  const nextByKey = new Map(next.map((r) => [userRowKey(r, tab), r]))
  const prevKeys = prev.map((r) => userRowKey(r, tab))
  const nextKeys = next.map((r) => userRowKey(r, tab))
  const sameKeySet =
    prevKeys.length === nextKeys.length && prevKeys.every((k) => nextByKey.has(k))

  const orderSource = silent && sameKeySet ? prev : next
  let anyChange = prev.length !== next.length

  const merged = orderSource.map((row) => {
    const key = userRowKey(row, tab)
    const fresh = nextByKey.get(key)
    if (!fresh) {
      anyChange = true
      return row
    }
    const fpOld = fingerprintUserRow(row, tab)
    const fpNew = fingerprintUserRow(fresh, tab)
    if (fpOld !== fpNew) anyChange = true
    return fpOld === fpNew ? row : fresh
  })

  if (
    !anyChange &&
    fingerprintUserRowsContent(prev, tab) === fingerprintUserRowsContent(merged, tab)
  ) {
    return prev
  }
  return merged
}

export function shouldApplyTabFetch(prev, next, tab) {
  const rowsChanged =
    fingerprintUserRowsContent(prev.items, tab) !== fingerprintUserRowsContent(next.items, tab)
  const paginationChanged =
    fingerprintPagination(prev.pagination) !== fingerprintPagination(next.pagination)
  return rowsChanged || paginationChanged
}
