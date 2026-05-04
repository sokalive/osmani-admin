/** DB plan row → API shape for admin UI */
export function planRowToApi(row) {
  if (!row) return null
  const fixed = row.fixed_expiry_time
  let fixedStr = '00:00'
  if (fixed != null) {
    const s =
      fixed instanceof Date ? fixed.toISOString().slice(11, 16) : String(fixed).slice(0, 8)
    const m = /^(\d{1,2}):(\d{2})/.exec(s)
    fixedStr = m ? `${m[1].padStart(2, '0')}:${m[2]}` : '00:00'
  }
  const ca = row.created_at
  const ua = row.updated_at
  return {
    id: Number(row.id),
    name: row.name ?? '',
    price: Number(row.price) || 0,
    durationDays: Number(row.duration_days) || 30,
    expiryType: row.expiry_type === 'fixed' ? 'fixed' : 'duration',
    fixedExpiryTime: fixedStr,
    isActive: Boolean(row.is_active),
    createdAt: ca instanceof Date ? ca.toISOString() : ca,
    updatedAt: ua instanceof Date ? ua.toISOString() : ua,
    activeSubscriberCount: Number(row.active_subscriber_count) || 0,
  }
}

/** DB transaction row (+ plan_name) → API list row */
export function transactionRowToApi(row) {
  if (!row) return null
  const ca = row.created_at
  return {
    id: Number(row.id),
    phone: row.phone ?? '',
    plan: row.plan_name != null ? String(row.plan_name) : '',
    planId: row.plan_id != null ? Number(row.plan_id) : null,
    amount: Number(row.amount) || 0,
    orderId: row.order_id ?? '',
    status: row.status ?? 'pending',
    date: ca instanceof Date ? ca.toISOString() : ca,
    currency: row.currency ?? 'TZS',
    externalId: row.external_id ?? null,
  }
}

export function maskSecret(s) {
  if (!s || String(s).length < 8) return ''
  const v = String(s)
  return `${v.slice(0, 4)}${'•'.repeat(Math.min(16, v.length - 8))}${v.slice(-4)}`
}
