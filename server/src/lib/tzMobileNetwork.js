import { normalizePhoneDigits } from '../billingStore.js'

/** Detect Tanzania mobile money operator from normalized phone digits. */
export function detectTzMobileNetwork(phone) {
  const digits = normalizePhoneDigits(phone)
  if (!digits) return { network: null, label: 'Unknown' }
  const local = digits.startsWith('255') ? digits.slice(3) : digits.startsWith('0') ? digits.slice(1) : digits
  const prefix3 = local.slice(0, 3)
  const prefix2 = local.slice(0, 2)

  if (['074', '075', '076', '077'].includes(prefix3) || prefix2 === '74' || prefix2 === '75') {
    return { network: 'vodacom', label: 'Vodacom / M-Pesa' }
  }
  if (['068', '069', '078', '079'].includes(prefix3)) {
    return { network: 'airtel', label: 'Airtel Money' }
  }
  if (['071', '065', '067'].includes(prefix3)) {
    return { network: 'yas', label: 'Yas / Mixx by Yas' }
  }
  if (['061', '062'].includes(prefix3)) {
    return { network: 'halotel', label: 'HaloPesa' }
  }
  if (prefix3 === '073' || prefix2 === '73') {
    return { network: 'ttcl', label: 'TTCL' }
  }
  return { network: 'other', label: 'Other / Unknown' }
}

export function paymentProviderFromRawPayload(raw) {
  const p = raw && typeof raw === 'object' ? raw : {}
  const label = String(p.payment_provider ?? p.provider ?? '').trim().toLowerCase()
  if (label.includes('sonic')) return 'sonicpesa'
  if (label.includes('aurax')) return 'auraxpay'
  if (label.includes('zeno')) return 'zenopay'
  const orderHint = String(p.order_id ?? p.orderId ?? '')
  if (orderHint.startsWith('osm_sp_')) return 'sonicpesa'
  if (orderHint.startsWith('osm_ax_')) return 'auraxpay'
  return label || 'zenopay'
}

export function ledgerStatusFromTransaction(row) {
  const recovery = String(row.recovery_state ?? '').trim().toUpperCase()
  if (recovery === 'MANUALLY_APPROVED') return 'MANUALLY_APPROVED'
  if (recovery === 'RECOVERY_REJECTED') return 'RECOVERY_REJECTED'
  if (recovery === 'RECOVERY_BLOCKED') return 'RECOVERY_BLOCKED'
  const st = String(row.status ?? 'pending').toLowerCase()
  if (st === 'completed') return 'SUCCESS'
  if (st === 'failed') return 'FAILED'
  if (st === 'pending') {
    const raw = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}
    if (raw.provider_initiation === 'failed') return 'FAILED'
    if (raw.provider_initiation === 'accepted' || raw.provider_initiation === 'pending') return 'PENDING'
    return 'INITIATED'
  }
  return String(st).toUpperCase()
}
