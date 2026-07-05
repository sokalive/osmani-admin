/**
 * Canonical SonicPesa (and shared) payment completion + entitlement activation.
 * Single idempotent path for webhook, poll, verify, and safe recovery.
 */
import { getPool } from '../db/pool.js'
import * as billing from '../billingStore.js'
import { isIntentionalMigrationRevokedDevice } from './transferRevocationGuard.js'

export const COMPLETION_SOURCE = Object.freeze({
  SONIC_WEBHOOK: 'sonic_webhook',
  ORDER_STATUS_POLL: 'order_status_poll',
  APP_VERIFY: 'app_verify',
  ADMIN_RECOVERY: 'admin_recovery',
})

export const ACTIVATION_STATE = Object.freeze({
  ACTIVATED: 'ACTIVATED',
  ALREADY_APPLIED: 'ALREADY_APPLIED',
  MOVED_TO_SIBLING_DEVICE: 'MOVED_TO_SIBLING_DEVICE',
  PHONE_CONFLICT: 'PHONE_CONFLICT',
  RETRYABLE_DB_ERROR: 'RETRYABLE_DB_ERROR',
  INVALID_PLAN: 'INVALID_PLAN',
  ORDER_NOT_FOUND: 'ORDER_NOT_FOUND',
  PROVIDER_NOT_CONFIRMED: 'PROVIDER_NOT_CONFIRMED',
  TERMINAL_REJECTED: 'TERMINAL_REJECTED',
  NOT_COMPLETED: 'NOT_COMPLETED',
  NO_DEVICE_ID: 'NO_DEVICE_ID',
})

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function dbQuery(client) {
  return (text, params) => (client ? client.query(text, params) : requirePool().query(text, params))
}

function redactId(s, n = 12) {
  const x = String(s ?? '')
  return x.length <= n ? x : `${x.slice(0, n)}…`
}

function buildActivationMeta(base = {}) {
  return {
    activation_state: base.activation_state ?? null,
    entitlement_active: base.entitlement_active === true,
    entitlement_device_id_redacted: base.entitlement_device_id_redacted ?? null,
    moved_to_sibling_device: base.moved_to_sibling_device === true,
    phone_conflict: base.phone_conflict === true,
    retryable: base.retryable === true,
    user_action_required: base.user_action_required === true,
    completion_source: base.completion_source ?? null,
    owner_device_id_redacted: base.owner_device_id_redacted ?? null,
  }
}

async function persistActivationMeta(orderId, meta, client = null) {
  const q = dbQuery(client)
  const oid = String(orderId ?? '').trim()
  if (!oid) return
  const { rows } = await q(`SELECT raw_payload FROM transactions WHERE order_id = $1`, [oid])
  const prev = rows[0]?.raw_payload && typeof rows[0].raw_payload === 'object' ? rows[0].raw_payload : {}
  await q(
    `UPDATE transactions SET raw_payload = $2::jsonb, updated_at = now() WHERE order_id = $1`,
    [oid, JSON.stringify({ ...prev, activation_result: buildActivationMeta(meta) })],
  )
}

/** Resolve explicit transfer target for a revoked source device (moved:*), not by phone. */
async function findSiblingEntitlementDevice(_phone, payingDeviceId) {
  const pool = requirePool()
  const paying = String(payingDeviceId ?? '').trim()
  if (!paying) return null
  const { rows } = await pool.query(
    `SELECT dt.target_device_id::text AS device_id
     FROM device_transfers dt
     INNER JOIN device_subscriptions ds ON ds.device_id = dt.target_device_id
     WHERE dt.status = 'completed'
       AND dt.source_device_id = $1
       AND LOWER(COALESCE(NULLIF(trim(ds.status::text), ''), 'active')) = 'active'
       AND ds.expires_at > now()
     ORDER BY COALESCE(dt.completed_at, dt.created_at) DESC
     LIMIT 1`,
    [paying],
  )
  return rows[0]?.device_id ? String(rows[0].device_id) : null
}

/**
 * Idempotent activation for an already-completed transaction row.
 */
export async function activateFromCompletedTxn(txn, { source = null, client = null } = {}) {
  if (!txn || String(txn.status ?? '').trim() !== 'completed') {
    return {
      ...buildActivationMeta({
        activation_state: ACTIVATION_STATE.NOT_COMPLETED,
        retryable: false,
        completion_source: source,
      }),
      activated: false,
      skipped: true,
      reason: 'not_completed',
      deviceId: null,
      orderId: txn?.order_id ? String(txn.order_id) : null,
    }
  }

  const orderIdEarly = String(txn.order_id ?? '').trim()
  if (orderIdEarly.startsWith('manual_grant:')) {
    return {
      ...buildActivationMeta({
        activation_state: ACTIVATION_STATE.TERMINAL_REJECTED,
        completion_source: source,
      }),
      activated: false,
      skipped: true,
      reason: 'manual_grant_txn',
      deviceId: String(txn.device_id ?? '').trim() || null,
      orderId: orderIdEarly,
    }
  }

  const planId = txn.plan_id
  if (!planId) {
    return {
      ...buildActivationMeta({
        activation_state: ACTIVATION_STATE.INVALID_PLAN,
        completion_source: source,
      }),
      activated: false,
      skipped: true,
      reason: 'no_plan',
      deviceId: null,
      orderId: orderIdEarly,
    }
  }

  let deviceId = String(txn.device_id ?? '').trim()
  const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  if (!deviceId) deviceId = String(raw.device_id ?? '').trim()
  const orderId = orderIdEarly
  if (!deviceId) {
    return {
      ...buildActivationMeta({
        activation_state: ACTIVATION_STATE.NO_DEVICE_ID,
        completion_source: source,
      }),
      activated: false,
      skipped: true,
      reason: 'no_device_id',
      deviceId: null,
      orderId,
    }
  }

  const { getAdminRevocationState, isAdminRevokedOrderBlocked } = await import(
    './adminSubscriptionRevocation.js'
  )
  const revocation = await getAdminRevocationState(deviceId, client)
  if (isAdminRevokedOrderBlocked(revocation, orderId)) {
    return {
      ...buildActivationMeta({
        activation_state: ACTIVATION_STATE.TERMINAL_REJECTED,
        completion_source: source,
      }),
      activated: false,
      skipped: true,
      reason: 'admin_revoked_order_blocked',
      code: 'ADMIN_REVOKED_ORDER_BLOCKED',
      deviceId,
      orderId,
    }
  }

  if (await isIntentionalMigrationRevokedDevice(deviceId)) {
    const phone = String(txn.phone ?? '').trim() || billing.phoneFromTransactionRow(txn)
    const sibling = phone ? await findSiblingEntitlementDevice(phone, deviceId) : null
    const meta = buildActivationMeta({
      activation_state: ACTIVATION_STATE.MOVED_TO_SIBLING_DEVICE,
      entitlement_active: Boolean(sibling),
      entitlement_device_id_redacted: sibling ? redactId(sibling) : null,
      moved_to_sibling_device: true,
      user_action_required: !sibling,
      completion_source: source,
    })
    await persistActivationMeta(orderId, meta, client)
    return {
      ...meta,
      activated: false,
      skipped: true,
      reason: 'MOVED_TO_SIBLING_DEVICE',
      code: 'MOVED_TO_SIBLING_DEVICE',
      deviceId,
      orderId,
      sibling_device_id: sibling,
    }
  }

  const plan = await billing.getPlanRowByIdAny(planId)
  if (!plan) {
    return {
      ...buildActivationMeta({
        activation_state: ACTIVATION_STATE.INVALID_PLAN,
        completion_source: source,
      }),
      activated: false,
      skipped: true,
      reason: 'plan_not_found',
      deviceId,
      orderId,
    }
  }

  const stack = await billing.computeDeviceSubscriptionExpiryAfterPurchase(deviceId, plan.duration_days)
  const expiresAt = stack.expiresAt
  const phone = String(txn.phone ?? '').trim() || billing.phoneFromTransactionRow(txn)
  if (phone && !String(txn.phone ?? '').trim()) {
    await billing.backfillTransactionPhoneIfMissing(orderId, phone)
  }

  const fpRaw = String(raw.device_fingerprint ?? raw.fingerprint ?? raw.deviceFingerprint ?? '').trim()
  const fpHash = fpRaw ? billing.hashDeviceFingerprint(fpRaw) : null

  try {
    const { skipped } = await billing.upsertDeviceSubscriptionActive(
      { deviceId, orderId, expiresAt, fingerprintHash: fpHash },
      client,
    )
    const state = skipped ? ACTIVATION_STATE.ALREADY_APPLIED : ACTIVATION_STATE.ACTIVATED
    const meta = buildActivationMeta({
      activation_state: state,
      entitlement_active: true,
      entitlement_device_id_redacted: redactId(deviceId),
      completion_source: source,
    })
    await persistActivationMeta(orderId, meta, client)
    return {
      ...meta,
      activated: !skipped,
      skipped,
      reason: skipped ? 'already_applied' : 'ok',
      deviceId,
      orderId,
      expiresAt,
    }
  } catch (e) {
    console.error('[canonical-activation] upsert failed:', redactId(orderId), e?.message || e)
    return {
      ...buildActivationMeta({
        activation_state: ACTIVATION_STATE.RETRYABLE_DB_ERROR,
        retryable: true,
        completion_source: source,
      }),
      activated: false,
      skipped: true,
      reason: 'db_error',
      deviceId,
      orderId,
      error: String(e?.message || e).slice(0, 200),
    }
  }
}

/**
 * Atomically transition payment + apply entitlement when provider confirms outcome.
 */
export async function applySonicpesaPaymentOutcome({
  orderId,
  source,
  succeeded = false,
  failed = false,
  providerPayload = null,
  externalId = null,
}) {
  const oid = String(orderId ?? '').trim()
  const out = {
    orderId: oid,
    source,
    txnStatusBefore: null,
    txnStatusAfter: null,
    transitioned: false,
    activation: null,
  }
  if (!oid) {
    out.activation = buildActivationMeta({
      activation_state: ACTIVATION_STATE.ORDER_NOT_FOUND,
      completion_source: source,
    })
    return out
  }

  if (!succeeded && !failed) {
    out.activation = buildActivationMeta({
      activation_state: ACTIVATION_STATE.PROVIDER_NOT_CONFIRMED,
      retryable: true,
      completion_source: source,
    })
    return out
  }

  const pool = requirePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(`SELECT * FROM transactions WHERE order_id = $1 FOR UPDATE`, [oid])
    const txn = rows[0] ?? null
    if (!txn) {
      await client.query('ROLLBACK')
      out.activation = buildActivationMeta({
        activation_state: ACTIVATION_STATE.ORDER_NOT_FOUND,
        completion_source: source,
      })
      return out
    }

    out.txnStatusBefore = String(txn.status ?? '')
    const prevPayload = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    if (prevPayload.payment_provider !== 'sonicpesa') {
      await client.query('ROLLBACK')
      out.activation = buildActivationMeta({
        activation_state: ACTIVATION_STATE.TERMINAL_REJECTED,
        completion_source: source,
      })
      return out
    }

    if (txn.status === 'completed') {
      const act = await activateFromCompletedTxn(txn, { source, client })
      await client.query('COMMIT')
      out.txnStatusAfter = 'completed'
      out.activation = act
      return out
    }

    if (txn.status === 'failed') {
      await client.query('COMMIT')
      out.txnStatusAfter = 'failed'
      out.activation = buildActivationMeta({
        activation_state: ACTIVATION_STATE.TERMINAL_REJECTED,
        completion_source: source,
      })
      return out
    }

    const nextStatus = succeeded ? 'completed' : failed ? 'failed' : txn.status
    if (nextStatus === txn.status) {
      await client.query('COMMIT')
      out.txnStatusAfter = String(txn.status ?? '')
      out.activation = buildActivationMeta({
        activation_state: ACTIVATION_STATE.PROVIDER_NOT_CONFIRMED,
        retryable: true,
        completion_source: source,
      })
      return out
    }

    const payloadPatch = { ...prevPayload, completion_source: source }
    if (source === COMPLETION_SOURCE.SONIC_WEBHOOK && providerPayload) {
      payloadPatch.sonic_webhook = providerPayload
      payloadPatch.webhookAt = new Date().toISOString()
    }
    if (source === COMPLETION_SOURCE.ORDER_STATUS_POLL && providerPayload) {
      payloadPatch.order_status_poll = providerPayload
      payloadPatch.orderStatusPolledAt = new Date().toISOString()
    }
    if (providerPayload?.data?.order_id ?? providerPayload?.order_id) {
      payloadPatch.provider_order_id = String(
        providerPayload?.data?.order_id ?? providerPayload?.order_id ?? prevPayload.provider_order_id ?? '',
      ).trim()
    }

    const { rows: updatedRows } = await client.query(
      `UPDATE transactions SET
         status = $2,
         external_id = COALESCE($3, external_id),
         raw_payload = $4::jsonb,
         updated_at = now()
       WHERE order_id = $1
       RETURNING *`,
      [
        oid,
        nextStatus,
        externalId != null ? String(externalId) : null,
        JSON.stringify(payloadPatch),
      ],
    )
    const updated = updatedRows[0]
    out.txnStatusAfter = nextStatus
    out.transitioned = nextStatus !== out.txnStatusBefore

    if (nextStatus !== 'completed') {
      await client.query('COMMIT')
      out.activation = buildActivationMeta({
        activation_state: ACTIVATION_STATE.TERMINAL_REJECTED,
        completion_source: source,
      })
      return out
    }

    const act = await activateFromCompletedTxn(updated, { source, client })
    if (act.activation_state === ACTIVATION_STATE.RETRYABLE_DB_ERROR) {
      await client.query('ROLLBACK')
      out.txnStatusAfter = out.txnStatusBefore
      out.transitioned = false
      out.activation = act
      return out
    }

    await client.query('COMMIT')
    out.activation = act
    return out
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('[canonical-activation] transaction failed:', redactId(oid), e?.message || e)
    out.activation = {
      ...buildActivationMeta({
        activation_state: ACTIVATION_STATE.RETRYABLE_DB_ERROR,
        retryable: true,
        completion_source: source,
      }),
      activated: false,
      skipped: true,
      reason: 'db_error',
      error: String(e?.message || e).slice(0, 200),
    }
    return out
  } finally {
    client.release()
  }
}
