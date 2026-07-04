/**
 * Admin payment recovery — idempotent subscription activation without falsifying provider SUCCESS.
 */
import { getPool } from '../db/pool.js'
import {
  computeDeviceSubscriptionExpiryAfterPurchase,
  getPlanRowByIdAny,
  getTransactionByOrderId,
  hashDeviceFingerprint,
  normalizePhoneDigits,
  phoneFromTransactionRow,
  upsertDeviceSubscriptionActive,
} from '../billingStore.js'
import { notifySubscriptionActivated } from './subscriptionActivationNotify.js'
import { detectTzMobileNetwork, paymentProviderFromRawPayload } from './tzMobileNetwork.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

export async function enrichTransactionLedgerFields(orderId, patch = {}) {
  const pool = requirePool()
  const txn = await getTransactionByOrderId(orderId)
  if (!txn) return null
  const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  const phone = String(patch.phone ?? txn.phone ?? phoneFromTransactionRow(txn) ?? '').trim()
  const normalized = normalizePhoneDigits(phone)
  const { network, label: networkLabel } = detectTzMobileNetwork(phone)
  const provider = paymentProviderFromRawPayload({ ...raw, order_id: orderId })
  await pool.query(
    `UPDATE transactions SET
       normalized_phone = COALESCE(NULLIF($2, ''), normalized_phone),
       mobile_network = COALESCE(NULLIF($3, ''), mobile_network),
       provider_label = COALESCE(NULLIF($4, ''), provider_label),
       updated_at = now()
     WHERE order_id = $1`,
    [orderId, normalized, network, provider],
  )
  return { normalized, network: networkLabel, provider }
}

/**
 * Idempotent admin recovery activation. Does NOT set transactions.status = completed.
 * Sets recovery_state = MANUALLY_APPROVED and activates device_subscriptions.
 */
export async function approveAdminPaymentRecovery({
  orderId,
  adminIdentity = 'admin',
  reason = '',
  idempotencyKey = null,
}) {
  const pool = requirePool()
  const oid = String(orderId ?? '').trim()
  if (!oid) throw new Error('order_id is required')
  if (oid.startsWith('manual_grant:')) throw new Error('Cannot recover manual grant orders via payment recovery')

  const idem = String(idempotencyKey ?? `admin_recovery:${oid}`).trim()

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const existing = await client.query(
      `SELECT * FROM admin_payment_recovery_actions WHERE idempotency_key = $1 LIMIT 1`,
      [idem],
    )
    if (existing.rows[0]) {
      await client.query('ROLLBACK')
      return {
        ok: true,
        alreadyApproved: true,
        action: existing.rows[0],
        idempotent: true,
      }
    }

    const { rows: txnRows } = await client.query(`SELECT * FROM transactions WHERE order_id = $1 FOR UPDATE`, [oid])
    const txn = txnRows[0]
    if (!txn) throw new Error('Transaction not found')
    if (String(txn.recovery_state ?? '').toUpperCase() === 'MANUALLY_APPROVED') {
      const prior = await client.query(
        `SELECT * FROM admin_payment_recovery_actions WHERE order_id = $1 AND action = 'approve' ORDER BY id DESC LIMIT 1`,
        [oid],
      )
      await client.query('COMMIT')
      return { ok: true, alreadyApproved: true, action: prior.rows[0] ?? null, idempotent: true }
    }
    if (String(txn.recovery_state ?? '').toUpperCase() === 'RECOVERY_REJECTED') {
      throw new Error('Recovery was rejected for this order')
    }

    const planId = txn.plan_id
    if (!planId) throw new Error('Transaction has no plan')
    let deviceId = String(txn.device_id ?? '').trim()
    const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (!deviceId) deviceId = String(raw.device_id ?? '').trim()
    if (!deviceId) throw new Error('device_id is required for recovery activation')

    const plan = await getPlanRowByIdAny(planId)
    if (!plan) throw new Error('Plan not found')

    const stack = await computeDeviceSubscriptionExpiryAfterPurchase(deviceId, plan.duration_days, client)
    const expiresAt = stack.expiresAt
    const fpRaw = String(raw.device_fingerprint ?? raw.fingerprint ?? '').trim()
    const fpHash = fpRaw ? hashDeviceFingerprint(fpRaw) : null

    const { skipped } = await upsertDeviceSubscriptionActive(
      { deviceId, orderId: oid, expiresAt, fingerprintHash: fpHash },
      client,
    )

    await client.query(
      `UPDATE transactions SET
         recovery_state = 'MANUALLY_APPROVED',
         recovery_approved_at = now(),
         recovery_approved_by = $2,
         updated_at = now()
       WHERE order_id = $1`,
      [oid, String(adminIdentity).slice(0, 256)],
    )

    const { rows: actionRows } = await client.query(
      `INSERT INTO admin_payment_recovery_actions (
         order_id, action, idempotency_key, admin_identity, reason,
         original_txn_status, original_recovery_state, device_id, plan_id,
         subscription_transaction_id, expires_at
       ) VALUES ($1, 'approve', $2, $3, $4, $5, $6, $7, $8, $9, $10::timestamptz)
       RETURNING *`,
      [
        oid,
        idem,
        String(adminIdentity).slice(0, 256),
        String(reason ?? '').slice(0, 2000),
        String(txn.status ?? ''),
        txn.recovery_state ?? null,
        deviceId,
        planId,
        oid,
        expiresAt,
      ],
    )

    await client.query('COMMIT')

    notifySubscriptionActivated(deviceId, oid)

    void import('./smsSubscriptionHooks.js')
      .then((m) =>
        m.notifyAdminPaymentRecoveryActivated({
          deviceId,
          orderId: oid,
          expiresAt,
          planId,
          amount: txn.amount,
        }),
      )
      .catch((err) => console.warn('[admin_payment_recovery] SMS failed:', err))

    return {
      ok: true,
      alreadyApproved: false,
      idempotent: false,
      skipped,
      activated: !skipped,
      deviceId,
      orderId: oid,
      expiresAt,
      action: actionRows[0],
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function rejectAdminPaymentRecovery({ orderId, adminIdentity = 'admin', reason = '' }) {
  const pool = requirePool()
  const oid = String(orderId ?? '').trim()
  if (!oid) throw new Error('order_id is required')
  const txn = await getTransactionByOrderId(oid)
  if (!txn) throw new Error('Transaction not found')

  await pool.query(
    `UPDATE transactions SET recovery_state = 'RECOVERY_REJECTED', updated_at = now() WHERE order_id = $1`,
    [oid],
  )

  const { rows } = await pool.query(
    `INSERT INTO admin_payment_recovery_actions (
       order_id, action, idempotency_key, admin_identity, reason,
       original_txn_status, original_recovery_state, device_id, plan_id
     ) VALUES ($1, 'reject', $2, $3, $4, $5, $6, $7, $8)
     RETURNING *`,
    [
      oid,
      `reject:${oid}:${Date.now()}`,
      String(adminIdentity).slice(0, 256),
      String(reason ?? '').slice(0, 2000),
      String(txn.status ?? ''),
      txn.recovery_state ?? null,
      txn.device_id ?? null,
      txn.plan_id ?? null,
    ],
  )
  return { ok: true, action: rows[0] }
}

export async function reconcilePaymentOrder(orderId) {
  return reconcileOrderWithZenoPay(String(orderId).trim(), { forcePoll: true })
}
