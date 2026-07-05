/**
 * Admin payment recovery — safe last-resort console.
 * Reuses canonical activation when provider/completed evidence exists.
 * Manual owner override is explicit, audited, and never falsifies transactions.status.
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
import { detectTzMobileNetwork, paymentProviderFromRawPayload } from './tzMobileNetwork.js'
import { reconcileOrderWithZenoPay } from '../paymentReconcile.js'
import {
  classifyPaymentRecoveryEligibility,
  RECOVERY_CLASS,
} from './paymentRecoveryEligibility.js'
import {
  activateFromCompletedTxn,
  COMPLETION_SOURCE,
} from './canonicalPaymentActivation.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function resolveOriginatingDeviceId(txn) {
  let deviceId = String(txn?.device_id ?? '').trim()
  const raw = txn?.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  if (!deviceId) deviceId = String(raw.device_id ?? '').trim()
  return deviceId
}

async function loadSubRow(deviceId, client = null) {
  const pool = requirePool()
  const q = client ? client.query.bind(client) : pool.query.bind(pool)
  const { rows } = await q(
    `SELECT device_id, status, expires_at, transaction_id
     FROM device_subscriptions WHERE device_id = $1 LIMIT 1`,
    [deviceId],
  )
  return rows[0] ?? null
}

async function insertRecoveryAudit(client, row) {
  const { rows } = await client.query(
    `INSERT INTO admin_payment_recovery_actions (
       order_id, action, idempotency_key, admin_identity, reason,
       original_txn_status, original_recovery_state, device_id, plan_id,
       subscription_transaction_id, expires_at
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::timestamptz)
     RETURNING *`,
    row,
  )
  return rows[0]
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

export async function getPaymentRecoveryEligibility(orderId) {
  const txn = await getTransactionByOrderId(orderId)
  if (!txn) return { ok: false, error: 'Transaction not found' }
  const deviceId = resolveOriginatingDeviceId(txn)
  const subRow = deviceId ? await loadSubRow(deviceId) : null
  const eligibility = await classifyPaymentRecoveryEligibility(txn, subRow)
  return { ok: true, eligibility }
}

/**
 * Safe admin recovery — classify, optionally poll provider, then canonical or explicit manual path.
 */
export async function recoverAdminPaymentOrder({
  orderId,
  adminIdentity = 'admin',
  reason = '',
  idempotencyKey = null,
  ownerOverride = false,
  attemptProviderPoll = true,
}) {
  const pool = requirePool()
  const oid = String(orderId ?? '').trim()
  if (!oid) throw new Error('order_id is required')

  const idem = String(idempotencyKey ?? `admin_recovery:${oid}`).trim()

  const poolCheck = await pool.query(
    `SELECT * FROM admin_payment_recovery_actions WHERE idempotency_key = $1 LIMIT 1`,
    [idem],
  )
  if (poolCheck.rows[0]) {
    return {
      ok: true,
      alreadyApproved: true,
      idempotent: true,
      action: poolCheck.rows[0],
      path: 'idempotent_replay',
    }
  }

  let txn = await getTransactionByOrderId(oid)
  if (!txn) throw new Error('Transaction not found')

  const deviceId0 = resolveOriginatingDeviceId(txn)
  const sub0 = deviceId0 ? await loadSubRow(deviceId0) : null
  const preEligibility = await classifyPaymentRecoveryEligibility(txn, sub0)

  if (
    preEligibility.class === RECOVERY_CLASS.ALREADY_RECOVERED ||
    preEligibility.class === RECOVERY_CLASS.ALREADY_APPLIED
  ) {
    const prior = await pool.query(
      `SELECT * FROM admin_payment_recovery_actions WHERE order_id = $1 ORDER BY id DESC LIMIT 1`,
      [oid],
    )
    return {
      ok: true,
      alreadyApproved: true,
      idempotent: true,
      eligibility: preEligibility,
      action: prior.rows[0] ?? null,
      path: 'already_recovered',
    }
  }

  if (preEligibility.class === RECOVERY_CLASS.ALREADY_ACTIVE) {
    return {
      ok: true,
      noActionRequired: true,
      activated: false,
      eligibility: preEligibility,
      path: 'already_active',
      code: 'ALREADY_ACTIVE',
    }
  }

  if (preEligibility.class === RECOVERY_CLASS.RECOVERY_REJECTED) {
    throw new Error('Recovery was rejected for this order')
  }

  if (preEligibility.class === RECOVERY_CLASS.EXPLICIT_TRANSFER_CASE) {
    return {
      ok: false,
      blocked: true,
      eligibility: preEligibility,
      path: 'explicit_transfer',
      code: 'EXPLICIT_TRANSFER_CASE',
      message: preEligibility.message,
    }
  }

  if (attemptProviderPoll && String(txn.status ?? '') === 'pending') {
    await reconcileOrderWithZenoPay(oid, { forcePoll: true })
    txn = await getTransactionByOrderId(oid)
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const dup = await client.query(
      `SELECT * FROM admin_payment_recovery_actions WHERE idempotency_key = $1 LIMIT 1`,
      [idem],
    )
    if (dup.rows[0]) {
      await client.query('COMMIT')
      return { ok: true, alreadyApproved: true, idempotent: true, action: dup.rows[0] }
    }

    const { rows: txnRows } = await client.query(`SELECT * FROM transactions WHERE order_id = $1 FOR UPDATE`, [oid])
    const lockedTxn = txnRows[0]
    if (!lockedTxn) throw new Error('Transaction not found')

    const deviceId = resolveOriginatingDeviceId(lockedTxn)
    const subRow = deviceId ? await loadSubRow(deviceId, client) : null
    const eligibility = await classifyPaymentRecoveryEligibility(lockedTxn, subRow, client)

    if (
      eligibility.class === RECOVERY_CLASS.ALREADY_RECOVERED ||
      eligibility.class === RECOVERY_CLASS.ALREADY_APPLIED ||
      eligibility.class === RECOVERY_CLASS.ALREADY_ACTIVE
    ) {
      await client.query('COMMIT')
      return {
        ok: true,
        alreadyApproved: eligibility.class !== RECOVERY_CLASS.ALREADY_ACTIVE,
        noActionRequired: eligibility.class === RECOVERY_CLASS.ALREADY_ACTIVE,
        idempotent: true,
        eligibility,
        path: 'post_poll_noop',
      }
    }

    if (eligibility.class === RECOVERY_CLASS.INTERNAL_COMPLETED_ACTIVATION_GAP || lockedTxn.status === 'completed') {
      const act = await activateFromCompletedTxn(lockedTxn, {
        source: COMPLETION_SOURCE.ADMIN_RECOVERY,
        client,
      })
      const action = await insertRecoveryAudit(client, [
        oid,
        'recover_canonical',
        idem,
        String(adminIdentity).slice(0, 256),
        String(reason ?? '').slice(0, 2000),
        String(lockedTxn.status ?? ''),
        lockedTxn.recovery_state ?? null,
        deviceId,
        lockedTxn.plan_id,
        oid,
        act.expiresAt ?? null,
      ])
      await client.query('COMMIT')
      return {
        ok: true,
        activated: act.activated === true,
        skipped: act.skipped === true,
        idempotent: act.skipped === true,
        eligibility,
        path: 'canonical_activation',
        activation: act,
        deviceId,
        orderId: oid,
        expiresAt: act.expiresAt ?? null,
        action,
      }
    }

    if (eligibility.requiresOwnerOverride && !ownerOverride) {
      await client.query('COMMIT')
      return {
        ok: false,
        blocked: true,
        requiresOwnerOverride: true,
        eligibility,
        path: 'blocked_pending_proof',
        code: eligibility.class,
        message: eligibility.message,
      }
    }

    if (!ownerOverride) {
      await client.query('COMMIT')
      return {
        ok: false,
        blocked: true,
        eligibility,
        path: 'blocked',
        code: eligibility.class,
        message: eligibility.message,
      }
    }

    const plan = await getPlanRowByIdAny(lockedTxn.plan_id)
    if (!plan) throw new Error('Plan not found')

    const raw = lockedTxn.raw_payload && typeof lockedTxn.raw_payload === 'object' ? lockedTxn.raw_payload : {}
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

    const action = await insertRecoveryAudit(client, [
      oid,
      'recover_manual',
      idem,
      String(adminIdentity).slice(0, 256),
      String(reason ?? '').slice(0, 2000),
      String(lockedTxn.status ?? ''),
      lockedTxn.recovery_state ?? null,
      deviceId,
      lockedTxn.plan_id,
      oid,
      expiresAt,
    ])

    await client.query('COMMIT')

    void import('./smsSubscriptionHooks.js')
      .then((m) =>
        m.notifyAdminPaymentRecoveryActivated({
          deviceId,
          orderId: oid,
          expiresAt,
          planId: lockedTxn.plan_id,
          amount: lockedTxn.amount,
        }),
      )
      .catch((err) => console.warn('[admin_payment_recovery] SMS failed:', err))

    return {
      ok: true,
      activated: !skipped,
      skipped,
      idempotent: skipped,
      alreadyApproved: false,
      ownerOverride: true,
      eligibility,
      path: 'manual_owner_override',
      deviceId,
      orderId: oid,
      expiresAt,
      action,
      txnStatusUnchanged: true,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Legacy approve alias — requires explicit owner_override for unproven orders. */
export async function approveAdminPaymentRecovery(opts) {
  return recoverAdminPaymentOrder(opts)
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
