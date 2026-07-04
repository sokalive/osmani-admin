import { adminDateFromIso } from './formatAdminDateTime.js'

/** @typedef {'ALL'|'ACTIVE'|'EXPIRING'|'EXPIRED'|'BLOCKED'|'CUSTOM'|'STANDARD'} HistoryFilter */

const MS_DAY = 86400000

function normSearch(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
}

function rowHaystack(row) {
  const txn = String(row.transactionId ?? '')
  const manualTxn = `manual_grant:${row.id}`
  return [
    String(row.id ?? ''),
    String(row.deviceId ?? ''),
    String(row.phone ?? ''),
    txn,
    manualTxn,
    row.manualCustom ? 'custom' : 'standard',
    String(row.planName ?? ''),
    String(row.createdBy ?? ''),
  ]
    .join(' ')
    .toLowerCase()
}

export function filterManualHistoryRows(rows, { search = '', filter = 'ALL', expiringSoonDays = 3, now = Date.now() } = {}) {
  const q = normSearch(search)
  const soonMs = Math.max(1, Number(expiringSoonDays) || 3) * MS_DAY

  return (Array.isArray(rows) ? rows : []).filter((row) => {
    if (q) {
      const hay = rowHaystack(row)
      const digits = q.replace(/\D/g, '')
      const matchText = hay.includes(q)
      const matchDigits =
        digits.length >= 3 &&
        (String(row.phone ?? '').replace(/\D/g, '').includes(digits) ||
          String(row.deviceId ?? '').replace(/\D/g, '').includes(digits) ||
          String(row.id ?? '').includes(digits))
      if (!matchText && !matchDigits) return false
    }

    const expMs = row.expiresAt ? new Date(row.expiresAt).getTime() : NaN
    const active = row.subscriptionActive === true
    const blocked = row.effectiveBlocked === true
    const expired = !active && (Number.isFinite(expMs) ? expMs <= now : true)
    const expiringSoon =
      active && Number.isFinite(expMs) && expMs > now && expMs - now <= soonMs

    switch (filter) {
      case 'ACTIVE':
        return active
      case 'EXPIRING':
        return expiringSoon
      case 'EXPIRED':
        return expired
      case 'BLOCKED':
        return blocked
      case 'CUSTOM':
        return row.manualCustom === true
      case 'STANDARD':
        return row.manualCustom !== true
      default:
        return true
    }
  })
}

/** Group filtered rows by EAT calendar date (newest date first). */
export function groupManualHistoryByDate(rows) {
  const map = new Map()
  for (const row of Array.isArray(rows) ? rows : []) {
    const key = adminDateFromIso(row.grantedAt) || 'unknown'
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(row)
  }
  return [...map.entries()]
    .sort((a, b) => {
      if (a[0] === 'unknown') return 1
      if (b[0] === 'unknown') return -1
      return b[0].localeCompare(a[0])
    })
    .map(([dateKey, groupRows]) => ({
      dateKey,
      rows: groupRows.sort((a, b) => {
        const ta = new Date(a.grantedAt || 0).getTime()
        const tb = new Date(b.grantedAt || 0).getTime()
        if (tb !== ta) return tb - ta
        return Number(b.id) - Number(a.id)
      }),
    }))
}
