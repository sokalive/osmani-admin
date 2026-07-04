import { getPool } from '../db/pool.js'
import { ledgerStatusFromTransaction } from './tzMobileNetwork.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function maskDeviceId(id) {
  const s = String(id ?? '')
  if (s.length <= 16) return s
  return `${s.slice(0, 8)}…${s.slice(-6)}`
}

function providerLabel(row) {
  const p = String(row.provider_label ?? '').trim()
  if (p === 'sonicpesa') return 'SonicPesa'
  if (p === 'auraxpay') return 'AuraxPay'
  if (p === 'zenopay') return 'ZenoPay'
  return p || 'Unknown'
}

function activationState(row) {
  if (row.sub_status === 'active' && row.sub_expires_at && new Date(row.sub_expires_at) > new Date()) {
    return 'active'
  }
  if (String(row.recovery_state ?? '').toUpperCase() === 'MANUALLY_APPROVED') return 'recovered'
  if (String(row.status) === 'completed') return 'completed_unverified'
  return 'inactive'
}

export async function listPaymentOrdersLedger({
  status = 'all',
  provider = 'all',
  search = '',
  limit = 200,
  offset = 0,
} = {}) {
  const pool = requirePool()
  const lim = Math.min(500, Math.max(1, Number(limit) || 200))
  const off = Math.max(0, Number(offset) || 0)
  const cond = ['t.plan_id IS NOT NULL']
  const params = []
  let i = 1

  if (status && status !== 'all') {
    const st = String(status).toUpperCase()
    if (st === 'SUCCESS') cond.push(`t.status = 'completed'`)
    else if (st === 'FAILED') cond.push(`t.status = 'failed'`)
    else if (st === 'PENDING' || st === 'INITIATED') cond.push(`t.status = 'pending'`)
    else if (st === 'MANUALLY_APPROVED') cond.push(`t.recovery_state = 'MANUALLY_APPROVED'`)
    else if (st === 'RECOVERY_REJECTED') cond.push(`t.recovery_state = 'RECOVERY_REJECTED'`)
  }

  if (provider && provider !== 'all') {
    cond.push(`COALESCE(t.provider_label, '') = $${i}`)
    params.push(String(provider).toLowerCase())
    i += 1
  }

  const q = String(search ?? '').trim()
  if (q) {
    cond.push(
      `(t.order_id ILIKE $${i} OR t.phone ILIKE $${i} OR t.device_id ILIKE $${i} OR t.external_id ILIKE $${i} OR t.normalized_phone ILIKE $${i})`,
    )
    params.push(`%${q}%`)
    i += 1
  }

  params.push(lim, off)
  const { rows } = await pool.query(
    `SELECT
       t.id,
       t.order_id,
       t.external_id,
       t.plan_id,
       t.phone,
       t.normalized_phone,
       t.mobile_network,
       t.provider_label,
       t.amount,
       t.currency,
       t.status,
       t.recovery_state,
       t.recovery_approved_at,
       t.recovery_approved_by,
       t.device_id,
       t.raw_payload,
       t.created_at,
       t.updated_at,
       t.completed_at,
       p.name AS plan_name,
       p.duration_days AS plan_duration_days,
       ds.status AS sub_status,
       ds.expires_at AS sub_expires_at,
       ds.transaction_id AS sub_transaction_id,
       apr.action AS last_recovery_action,
       apr.sms_sent AS recovery_sms_sent,
       apr.created_at AS recovery_action_at
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id
     LEFT JOIN device_subscriptions ds ON ds.device_id = t.device_id
     LEFT JOIN LATERAL (
       SELECT action, sms_sent, created_at
       FROM admin_payment_recovery_actions
       WHERE order_id = t.order_id
       ORDER BY id DESC LIMIT 1
     ) apr ON true
     WHERE ${cond.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    params,
  )

  return rows.map((r) => {
    const raw = r.raw_payload && typeof r.raw_payload === 'object' ? r.raw_payload : {}
    const ledgerStatus = ledgerStatusFromTransaction(r)
    return {
      id: r.id,
      orderId: r.order_id,
      order_id: r.order_id,
      externalId: r.external_id ?? null,
      provider: providerLabel(r),
      providerKey: r.provider_label ?? null,
      phone: r.phone ?? '',
      normalizedPhone: r.normalized_phone ?? '',
      mobileNetwork: r.mobile_network ?? null,
      amount: Number(r.amount) || 0,
      currency: r.currency ?? 'TZS',
      planId: r.plan_id,
      planName: r.plan_name ?? '',
      planDurationDays: r.plan_duration_days ?? null,
      status: r.status,
      ledgerStatus,
      recoveryState: r.recovery_state ?? null,
      deviceId: r.device_id ?? '',
      deviceIdMasked: maskDeviceId(r.device_id),
      createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : r.created_at,
      updatedAt: r.updated_at instanceof Date ? r.updated_at.toISOString() : r.updated_at,
      completedAt: r.completed_at instanceof Date ? r.completed_at.toISOString() : r.completed_at,
      recoveryApprovedAt:
        r.recovery_approved_at instanceof Date ? r.recovery_approved_at.toISOString() : r.recovery_approved_at,
      recoveryApprovedBy: r.recovery_approved_by ?? null,
      subscriptionActivation: activationState(r),
      subExpiresAt: r.sub_expires_at instanceof Date ? r.sub_expires_at.toISOString() : r.sub_expires_at,
      subTransactionId: r.sub_transaction_id ?? null,
      providerInitiation: raw.provider_initiation ?? null,
      failureReason: raw.provider_initiation === 'failed' ? raw.httpStatus ?? 'provider_rejected' : null,
      manualRecoveryUsed: String(r.recovery_state ?? '').toUpperCase() === 'MANUALLY_APPROVED',
      recoverySmsSent: r.recovery_sms_sent === true,
      lastRecoveryAction: r.last_recovery_action ?? null,
    }
  })
}

export async function getPaymentOrderDetail(orderId) {
  const pool = requirePool()
  const oid = String(orderId ?? '').trim()
  const { rows } = await pool.query(
    `SELECT t.*, p.name AS plan_name, p.duration_days
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE t.order_id = $1`,
    [oid],
  )
  const txn = rows[0]
  if (!txn) return null
  const actions = await pool.query(
    `SELECT id, action, admin_identity, reason, created_at, sms_sent, expires_at
     FROM admin_payment_recovery_actions WHERE order_id = $1 ORDER BY id ASC`,
    [oid],
  )
  const list = await listPaymentOrdersLedger({ search: oid, limit: 1 })
  return { order: list[0] ?? null, transaction: txn, recoveryActions: actions.rows }
}
