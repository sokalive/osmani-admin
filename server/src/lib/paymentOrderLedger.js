import { getPool } from '../db/pool.js'
import { normalizePhoneDigits, tzPhoneCanonicalSql } from '../billingStore.js'
import { ledgerStatusFromTransaction } from './tzMobileNetwork.js'
import { classifyPaymentOrderRecovery, mapOwnerFacingRecovery } from './paymentOrderRecoveryClassifier.js'

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
  const classified = classifyPaymentOrderRecovery(row)
  if (classified.recoveryClass === 'ALREADY_ACTIVE') return 'active'
  if (String(row.recovery_state ?? '').toUpperCase() === 'MANUALLY_APPROVED') return 'recovered'
  if (String(row.status) === 'completed') return 'completed_unverified'
  return 'inactive'
}

/** 64-char hex device_id (authoritative exact match). */
export function isExactDeviceId(q) {
  return /^[a-f0-9]{64}$/i.test(String(q ?? '').trim())
}

function isLikelyOrderId(q) {
  const s = String(q ?? '').trim()
  if (!s) return false
  if (/^osm_[a-z]{2}_/i.test(s)) return true
  return /^[A-Za-z0-9][A-Za-z0-9_-]{10,}$/.test(s)
}

function looksLikePhoneQuery(q) {
  const raw = String(q ?? '').trim()
  if (!raw) return false
  if (/^[+0]/.test(raw) || /^255\d{9}$/.test(raw.replace(/\D/g, ''))) return true
  const digits = normalizePhoneDigits(raw)
  return Boolean(digits && digits.length >= 12 && /^255\d{9}$/.test(digits))
}

/**
 * SQL fragment for ledger tab filters — mirrors ledgerStatusFromTransaction().
 * @returns {string|null}
 */
export function ledgerStatusFilterSql(status) {
  const st = String(status ?? 'all').toUpperCase()
  if (!st || st === 'ALL') return null
  if (st === 'SUCCESS') {
    return `(
      t.status = 'completed'
      AND COALESCE(UPPER(t.recovery_state), '') NOT IN ('MANUALLY_APPROVED', 'RECOVERY_REJECTED', 'RECOVERY_BLOCKED')
    )`
  }
  if (st === 'FAILED') {
    return `(
      t.status = 'failed'
      OR (t.status = 'pending' AND COALESCE(t.raw_payload->>'provider_initiation', '') = 'failed')
      OR UPPER(COALESCE(t.recovery_state, '')) = 'RECOVERY_REJECTED'
    )`
  }
  if (st === 'PENDING' || st === 'INITIATED') {
    return `(
      t.status = 'pending'
      AND COALESCE(UPPER(t.recovery_state), '') NOT IN ('MANUALLY_APPROVED', 'RECOVERY_REJECTED', 'RECOVERY_BLOCKED')
      AND COALESCE(t.raw_payload->>'provider_initiation', '') <> 'failed'
    )`
  }
  if (st === 'MANUALLY_APPROVED') {
    return `UPPER(COALESCE(t.recovery_state, '')) = 'MANUALLY_APPROVED'`
  }
  if (st === 'RECOVERY_REJECTED') {
    return `UPPER(COALESCE(t.recovery_state, '')) = 'RECOVERY_REJECTED'`
  }
  return null
}

/**
 * Build search WHERE clause for payment orders list.
 * @returns {{ clause: string|null, params: unknown[], nextIndex: number }}
 */
export function buildPaymentOrderSearchClause(search, startIndex = 1) {
  const q = String(search ?? '').trim()
  if (!q) return { clause: null, params: [], nextIndex: startIndex }

  if (isExactDeviceId(q)) {
    return {
      clause: `t.device_id = $${startIndex}`,
      params: [q.toLowerCase()],
      nextIndex: startIndex + 1,
    }
  }

  if (looksLikePhoneQuery(q)) {
    const digits = normalizePhoneDigits(q)
    if (digits && digits.length >= 9) {
      const clause = `(
        ${tzPhoneCanonicalSql('t.phone::text')} = $${startIndex}
        OR COALESCE(t.normalized_phone, '') = $${startIndex}
        OR t.device_id IN (
          SELECT DISTINCT trim(d.device_id::text)
          FROM (
            SELECT device_id FROM transactions
            WHERE device_id IS NOT NULL AND trim(device_id) <> ''
              AND ${tzPhoneCanonicalSql('phone::text')} = $${startIndex}
            UNION
            SELECT device_id FROM device_phone_registry
            WHERE phone_number_normalized = $${startIndex}
          ) d
        )
      )`
      return { clause, params: [digits], nextIndex: startIndex + 1 }
    }
  }

  if (isLikelyOrderId(q)) {
    return {
      clause: `(t.order_id = $${startIndex} OR t.external_id = $${startIndex})`,
      params: [q],
      nextIndex: startIndex + 1,
    }
  }

  return {
    clause: `(t.order_id ILIKE $${startIndex} OR t.phone ILIKE $${startIndex} OR t.device_id ILIKE $${startIndex} OR t.external_id ILIKE $${startIndex} OR t.normalized_phone ILIKE $${startIndex})`,
    params: [`%${q}%`],
    nextIndex: startIndex + 1,
  }
}

function buildListConditions({ status = 'all', provider = 'all', search = '' } = {}) {
  const cond = ['t.plan_id IS NOT NULL']
  const params = []
  let i = 1

  const statusSql = ledgerStatusFilterSql(status)
  if (statusSql) cond.push(statusSql)

  if (provider && provider !== 'all') {
    cond.push(`COALESCE(t.provider_label, '') = $${i}`)
    params.push(String(provider).toLowerCase())
    i += 1
  }

  const searchBuilt = buildPaymentOrderSearchClause(search, i)
  if (searchBuilt.clause) {
    cond.push(searchBuilt.clause)
    params.push(...searchBuilt.params)
    i = searchBuilt.nextIndex
  }

  return { cond, params, nextIndex: i }
}

const LIST_SELECT = `SELECT
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
       ds.admin_revoked_at,
       ds.admin_revoked_transaction_id,
       sup.superseding_order_id,
       sup.superseding_created_at,
       hamisha.hamisha_transfer_id,
       hamisha.hamisha_target_device_id,
       hamisha.hamisha_transfer_completed_at,
       hamisha.hamisha_transfer_reason,
       apr.action AS last_recovery_action,
       apr.sms_sent AS recovery_sms_sent,
       apr.created_at AS recovery_action_at
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id
     LEFT JOIN device_subscriptions ds ON ds.device_id = t.device_id
     LEFT JOIN LATERAL (
       SELECT t2.order_id AS superseding_order_id, t2.created_at AS superseding_created_at
       FROM transactions t2
       WHERE trim(coalesce(t2.device_id, '')) = trim(coalesce(t.device_id, ''))
         AND t2.status = 'completed'
         AND t2.order_id <> t.order_id
         AND t2.created_at > t.created_at
         AND t2.plan_id IS NOT NULL
       ORDER BY t2.created_at ASC
       LIMIT 1
     ) sup ON true
     LEFT JOIN LATERAL (
       SELECT dt.id AS hamisha_transfer_id,
              dt.target_device_id AS hamisha_target_device_id,
              dt.completed_at AS hamisha_transfer_completed_at,
              dt.reason AS hamisha_transfer_reason
       FROM device_transfers dt
       WHERE dt.status = 'completed'
         AND dt.source_device_id = t.device_id
         AND trim(coalesce(ds.transaction_id, '')) = trim(t.order_id)
         AND coalesce(ds.transaction_id::text, '') NOT LIKE 'moved:%'
         AND dt.completed_at >= COALESCE(t.completed_at, t.created_at)
         AND EXISTS (
           SELECT 1 FROM device_subscriptions ds_tgt
           WHERE ds_tgt.device_id = dt.target_device_id
             AND (
               ds_tgt.transaction_id LIKE 'transfer:%'
               OR ds_tgt.transaction_id LIKE 'force:%'
             )
         )
       ORDER BY dt.completed_at DESC
       LIMIT 1
     ) hamisha ON true
     LEFT JOIN LATERAL (
       SELECT action, sms_sent, created_at
       FROM admin_payment_recovery_actions
       WHERE order_id = t.order_id
       ORDER BY id DESC LIMIT 1
     ) apr ON true`

function mapLedgerRow(r) {
  const raw = r.raw_payload && typeof r.raw_payload === 'object' ? r.raw_payload : {}
  const ledgerStatus = ledgerStatusFromTransaction(r)
  const recovery = mapOwnerFacingRecovery(classifyPaymentOrderRecovery(r))
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
    supersedingOrderId: r.superseding_order_id ?? null,
    adminRevokedAt: r.admin_revoked_at instanceof Date ? r.admin_revoked_at.toISOString() : r.admin_revoked_at,
    adminRevokedTransactionId: r.admin_revoked_transaction_id ?? null,
    providerInitiation: raw.provider_initiation ?? null,
    failureReason: raw.provider_initiation === 'failed' ? raw.httpStatus ?? 'provider_rejected' : null,
    manualRecoveryUsed: String(r.recovery_state ?? '').toUpperCase() === 'MANUALLY_APPROVED',
    recoverySmsSent: r.recovery_sms_sent === true,
    lastRecoveryAction: r.last_recovery_action ?? null,
    recoveryClass: recovery.recoveryDiagnosticClass ?? recovery.recoveryClass,
    recoveryDiagnosticClass: recovery.recoveryDiagnosticClass ?? recovery.recoveryClass,
    recoveryLabel: recovery.recoveryLabel,
    recoveryReason: recovery.recoveryReason,
    recoverySeverity: recovery.recoverySeverity,
    recoveryActionable: recovery.recoveryActionable,
    recoveryEvidence: recovery.recoveryEvidence,
    recoveryHint: recovery.recoveryHint,
  }
}

export async function countPaymentOrdersLedger(filters = {}) {
  const pool = requirePool()
  const { cond, params } = buildListConditions(filters)
  const { rows } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM transactions t WHERE ${cond.join(' AND ')}`,
    params,
  )
  return Number(rows[0]?.n) || 0
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
  const { cond, params, nextIndex: i } = buildListConditions({ status, provider, search })
  params.push(lim, off)

  const { rows } = await pool.query(
    `${LIST_SELECT}
     WHERE ${cond.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT $${i} OFFSET $${i + 1}`,
    params,
  )

  return rows.map(mapLedgerRow)
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
