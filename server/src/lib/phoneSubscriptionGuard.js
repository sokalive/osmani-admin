/**
 * Payment-bound entitlement: each device activates from its own trusted order record.
 * Same phone on different devices may each hold independent active subscriptions.
 * Explicit transfer flows (moved:* / device_transfers) remain separate.
 */
import {
  getTransactionByOrderId,
  normalizePhoneDigits,
  tzPhoneCanonicalSql,
  updateTransactionByOrderId,
} from '../billingStore.js'
import { getPool } from '../db/pool.js'

export const PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION = 'PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION'

/** @deprecated use PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION */
export const PHONE_SUBSCRIPTION_CONFLICT_LEGACY = 'phone_subscription_conflict'

export const PHONE_SUBSCRIPTION_CONFLICT_MESSAGE =
  'Namba hii tayari ina kifurushi kinachoendelea kwenye kifaa kingine. Subiri kifurushi kiishe au tumia kifaa kilicholipiwa.'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

/** Subscriptions revoked by completed package migration (source device keeps moved:* row). */
function migrationRevokedSql(dsAlias = 'ds') {
  return `COALESCE(${dsAlias}.transaction_id::text, '') NOT LIKE 'moved:%'`
}

/** Transfer sources must not count as active phone owners after completed migration. */
function notCompletedTransferSourceSql(dsAlias = 'ds') {
  return `NOT EXISTS (
    SELECT 1 FROM device_transfers dt
    WHERE dt.status = 'completed'
      AND dt.source_device_id::text = ${dsAlias}.device_id::text
  )`
}

function phoneDevicesCteSql() {
  return `
    phone_devices AS (
      SELECT DISTINCT trim(t.device_id::text) AS device_id
      FROM transactions t
      WHERE t.status = 'completed'
        AND trim(coalesce(t.device_id::text, '')) <> ''
        AND trim(coalesce(t.phone::text, '')) <> ''
        AND ${tzPhoneCanonicalSql('t.phone::text')} = $1
      UNION
      SELECT DISTINCT trim(dpr.device_id::text) AS device_id
      FROM device_phone_registry dpr
      WHERE trim(coalesce(dpr.device_id::text, '')) <> ''
        AND trim(coalesce(dpr.phone_number_normalized::text, '')) = $1
      UNION
      SELECT DISTINCT trim(ir.device_id::text) AS device_id
      FROM device_intelligence_registry ir
      WHERE trim(coalesce(ir.device_id::text, '')) <> ''
        AND (
          ${tzPhoneCanonicalSql('ir.phone_number')} = $1
          OR ${tzPhoneCanonicalSql('ir.account_id')} = $1
        )
    )`
}

function computeRemainingDays(expiresAt) {
  if (!expiresAt) return 0
  const exp = expiresAt instanceof Date ? expiresAt : new Date(String(expiresAt))
  if (Number.isNaN(exp.getTime())) return 0
  return Math.max(0, Math.ceil((exp.getTime() - Date.now()) / 86400000))
}

async function loadOwnerPackageDetails(deviceId) {
  const id = String(deviceId ?? '').trim()
  if (!id) return { plan_name: null }
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT p.name AS plan_name
     FROM device_subscriptions ds
     LEFT JOIN transactions t ON t.order_id = ds.transaction_id
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE ds.device_id = $1
     ORDER BY ds.expires_at DESC NULLS LAST
     LIMIT 1`,
    [id],
  )
  return { plan_name: rows[0]?.plan_name != null ? String(rows[0].plan_name) : null }
}

/**
 * Active subscriptions on devices bound to this payment phone (no install_instance expansion).
 * Active = status active (or unset) AND expires_at > now() AND not admin-blocked.
 */
export async function listActivePhoneSubscriptionDevices(phoneInput) {
  const digits = normalizePhoneDigits(phoneInput)
  if (!digits || digits.length < 10) return []
  const pool = requirePool()
  const { rows } = await pool.query(
    `WITH ${phoneDevicesCteSql()}
     SELECT
       ds.device_id::text AS device_id,
       ds.expires_at,
       ds.status,
       ds.transaction_id,
       ds.started_at,
       ds.updated_at,
       p.name AS plan_name
     FROM device_subscriptions ds
     INNER JOIN phone_devices pd ON pd.device_id = ds.device_id::text
     LEFT JOIN transactions t ON t.order_id = ds.transaction_id
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE ds.expires_at > now()
       AND LOWER(COALESCE(NULLIF(trim(ds.status::text), ''), 'active')) = 'active'
       AND COALESCE(ds.manual_admin_blocked, false) = false
       AND ${migrationRevokedSql('ds')}
       AND ${notCompletedTransferSourceSql('ds')}
     ORDER BY ds.expires_at DESC`,
    [digits],
  )
  return rows.map((r) => ({
    device_id: String(r.device_id ?? ''),
    expires_at: r.expires_at,
    status: String(r.status ?? 'active'),
    transaction_id: r.transaction_id != null ? String(r.transaction_id) : null,
    started_at: r.started_at,
    updated_at: r.updated_at,
    plan_name: r.plan_name != null ? String(r.plan_name) : null,
  }))
}

async function buildConflictAssessment(owner, activeDevices) {
  const details = owner.plan_name ? { plan_name: owner.plan_name } : await loadOwnerPackageDetails(owner.device_id)
  const expiresIso =
    owner.expires_at instanceof Date
      ? owner.expires_at.toISOString()
      : owner.expires_at
        ? String(owner.expires_at)
        : null
  return {
    allowed: false,
    reason: PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION,
    ownerDeviceId: owner.device_id,
    existing_device_id: owner.device_id,
    existing_expiry: expiresIso,
    remaining_days: computeRemainingDays(owner.expires_at),
    existing_package: details.plan_name,
    activeDevices,
    message: PHONE_SUBSCRIPTION_CONFLICT_MESSAGE,
    message_sw: PHONE_SUBSCRIPTION_CONFLICT_MESSAGE,
  }
}

/**
 * @returns {Promise<{ allowed: boolean, reason: string, ownerDeviceId: string|null, existing_device_id?: string, existing_expiry?: string|null, remaining_days?: number, existing_package?: string|null, activeDevices: object[], message: string|null, message_sw?: string|null }>}
 */
export async function assessPhoneSubscriptionActivation(payingDeviceId, phoneInput) {
  const paying = String(payingDeviceId ?? '').trim()
  const digits = normalizePhoneDigits(phoneInput)
  if (!paying) {
    return {
      allowed: false,
      reason: 'missing_device_id',
      ownerDeviceId: null,
      activeDevices: [],
      message: 'deviceId is required',
    }
  }
  if (!digits || digits.length < 10) {
    return {
      allowed: true,
      reason: 'no_phone',
      ownerDeviceId: null,
      activeDevices: [],
      message: null,
    }
  }

  const activeDevices = await listActivePhoneSubscriptionDevices(digits)

  const pool = requirePool()
  const { rows: payingSubRows } = await pool.query(
    `SELECT device_id::text AS device_id, expires_at, status, transaction_id
     FROM device_subscriptions
     WHERE device_id = $1
       AND expires_at > now()
       AND LOWER(COALESCE(NULLIF(trim(status::text), ''), 'active')) = 'active'
       AND COALESCE(manual_admin_blocked, false) = false
       AND ${migrationRevokedSql('device_subscriptions')}
       AND ${notCompletedTransferSourceSql('device_subscriptions')}
     LIMIT 1`,
    [paying],
  )
  if (payingSubRows[0]) {
    const own = {
      device_id: String(payingSubRows[0].device_id ?? paying),
      expires_at: payingSubRows[0].expires_at,
      status: String(payingSubRows[0].status ?? 'active'),
      transaction_id:
        payingSubRows[0].transaction_id != null ? String(payingSubRows[0].transaction_id) : null,
    }
    const merged = activeDevices.some((d) => d.device_id === paying)
      ? activeDevices
      : [own, ...activeDevices]
    return {
      allowed: true,
      reason: 'same_device_renewal',
      ownerDeviceId: paying,
      activeDevices: merged,
      message: null,
    }
  }

  const payingActive = activeDevices.find((d) => d.device_id === paying)
  if (payingActive) {
    return {
      allowed: true,
      reason: 'same_device_renewal',
      ownerDeviceId: paying,
      activeDevices,
      message: null,
    }
  }

  const otherActive = activeDevices.filter((d) => d.device_id !== paying)
  if (otherActive.length > 0) {
    return {
      allowed: true,
      reason: 'independent_device_payment',
      ownerDeviceId: paying,
      activeDevices,
      message: null,
      other_active_device_count: otherActive.length,
    }
  }

  return {
    allowed: true,
    reason: 'no_conflict',
    ownerDeviceId: null,
    activeDevices,
    message: null,
  }
}

export async function assertPhoneSubscriptionPaymentAllowed(payingDeviceId, phoneInput) {
  const assessment = await assessPhoneSubscriptionActivation(payingDeviceId, phoneInput)
  return { ok: assessment.allowed, ...assessment }
}

export function phoneSubscriptionConflictHttpBody(assessment) {
  const existingDeviceId = assessment.existing_device_id ?? assessment.ownerDeviceId ?? null
  const existingExpiry = assessment.existing_expiry ?? null
  const remainingDays =
    assessment.remaining_days != null
      ? assessment.remaining_days
      : computeRemainingDays(assessment.activeDevices?.find((d) => d.device_id === existingDeviceId)?.expires_at)
  const existingPackage =
    assessment.existing_package ??
    assessment.activeDevices?.find((d) => d.device_id === existingDeviceId)?.plan_name ??
    null

  return {
    success: false,
    code: PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION,
    message_sw: PHONE_SUBSCRIPTION_CONFLICT_MESSAGE,
    existing_device_id: existingDeviceId,
    existing_expiry: existingExpiry,
    remaining_days: remainingDays,
    existing_package: existingPackage,
    error: PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION,
    message: PHONE_SUBSCRIPTION_CONFLICT_MESSAGE,
    ownerDeviceId: existingDeviceId,
    reason: assessment.reason || PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION,
  }
}

/** Keep completed payment; flag for manual review without activating on wrong device. */
export async function markTransactionPhoneActivationConflict(orderId, meta = {}) {
  const oid = String(orderId ?? '').trim()
  if (!oid) return null
  const txn = await getTransactionByOrderId(oid)
  if (!txn) return null
  const prev =
    txn.raw_payload && typeof txn.raw_payload === 'object' ? { ...txn.raw_payload } : {}
  const raw_payload = {
    ...prev,
    phone_conflict: true,
    manual_review: true,
    activation_skipped_reason: PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION,
    phone_conflict_owner_device_id: meta.ownerDeviceId ?? null,
    phone_conflict_paying_device_id: meta.payingDeviceId ?? null,
    phone_conflict_at: new Date().toISOString(),
    phone_conflict_message: PHONE_SUBSCRIPTION_CONFLICT_MESSAGE,
    phone_conflict_code: PHONE_ALREADY_HAS_ACTIVE_SUBSCRIPTION,
  }
  return updateTransactionByOrderId(oid, {
    status: txn.status === 'completed' ? 'completed' : txn.status,
    raw_payload,
  })
}

/**
 * Admin audit: active devices for phone, recent phone_conflict txns, policy assessment for optional device_id.
 */
export async function auditPhoneSubscriptionOwnership(phoneInput, opts = {}) {
  const digits = normalizePhoneDigits(phoneInput)
  const probeDeviceId = String(opts.deviceId ?? opts.device_id ?? '').trim()
  const pool = requirePool()
  const activeDevices = digits ? await listActivePhoneSubscriptionDevices(digits) : []

  let conflictTransactions = []
  if (digits) {
    const { rows } = await pool.query(
      `SELECT order_id, device_id, phone, status, amount, plan_id, created_at, updated_at, raw_payload
       FROM transactions t
       WHERE ${tzPhoneCanonicalSql('t.phone::text')} = $1
         AND (
           coalesce(t.raw_payload->>'phone_conflict', '') = 'true'
           OR coalesce(t.raw_payload->>'manual_review', '') = 'true'
         )
       ORDER BY t.created_at DESC
       LIMIT 50`,
      [digits],
    )
    conflictTransactions = rows.map((r) => ({
      order_id: String(r.order_id ?? ''),
      device_id: r.device_id != null ? String(r.device_id) : '',
      status: String(r.status ?? ''),
      phone_conflict: r.raw_payload?.phone_conflict === true,
      manual_review: r.raw_payload?.manual_review === true,
      owner_device_id: r.raw_payload?.phone_conflict_owner_device_id ?? null,
      created_at: r.created_at,
    }))
  }

  let probeAssessment = null
  if (probeDeviceId && digits) {
    probeAssessment = await assessPhoneSubscriptionActivation(probeDeviceId, digits)
  }

  return {
    phone_normalized: digits || null,
    policy: 'payment_bound_to_originating_device',
    active_devices: activeDevices,
    multiple_active: activeDevices.length > 1,
    conflict_transactions: conflictTransactions,
    probe_device_id: probeDeviceId || null,
    probe_assessment: probeAssessment,
  }
}
