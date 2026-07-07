import { getPool } from '../db/pool.js'
import { notifySubscriptionTransferred } from './subscriptionTransferNotify.js'
import {
  findActiveDeviceIdForPaymentPhone,
  getDeviceSubscriptionAccessState,
  hashDeviceFingerprint,
  normalizePhoneDigits,
  resolvePaymentPhoneForDevice,
} from '../billingStore.js'
import { getDeviceIntelligenceByDeviceId } from './deviceIntelligenceStore.js'
import {
  isCompletedTransferSourceDevice,
  isIntentionalMigrationRevokedDevice,
  isReverseTransferMigrationBlocked,
} from './transferRevocationGuard.js'
import { rejectUnauthorizedCrossDeviceMigration } from './subscriptionEntitlementPolicy.js'

function phoneCanonicalSql(expr) {
  return `(
    CASE
      WHEN regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g') ~ '^0[0-9]{9}$'
        THEN '255' || substr(regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g'), 2)
      WHEN regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g') ~ '^[67][0-9]{8}$'
        THEN '255' || regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g')
      ELSE regexp_replace(COALESCE(${expr}, ''), '[^0-9]', '', 'g')
    END
  )`
}

function normalizeLegacyDeviceHint(hint) {
  const s = String(hint ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-f0-9]/g, '')
  return s.length >= 6 ? s : ''
}

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

const FULL_MIGRATION_COOLDOWN_MS = Math.max(
  15_000,
  Number(process.env.SUBSCRIPTION_FULL_MIGRATION_COOLDOWN_MS) || 60_000,
)

/** @type {Map<string, number>} */
const fullMigrationAttemptAt = new Map()

function hasExplicitMigrationHints({ phone, legacyDeviceId, accountId }) {
  const phoneDigits = normalizePhoneDigits(phone)
  const acctDigits = normalizePhoneDigits(accountId)
  return (
    Boolean(String(legacyDeviceId ?? '').trim()) ||
    Boolean(String(accountId ?? '').trim()) ||
    (phoneDigits && phoneDigits.length >= 10) ||
    (acctDigits && acctDigits.length >= 10)
  )
}

function shouldRunFullMigrationScan(deviceId, hints) {
  if (hasExplicitMigrationHints(hints)) return true
  const d = String(deviceId ?? '').trim()
  if (!d) return false
  const last = fullMigrationAttemptAt.get(d) || 0
  if (Date.now() - last < FULL_MIGRATION_COOLDOWN_MS) return false
  fullMigrationAttemptAt.set(d, Date.now())
  return true
}

/** Fast VPS APK reinstall path — fingerprint-only recovery (single transaction). */
export async function tryFastFingerprintRecovery(deviceId, fingerprint) {
  const blocked = rejectUnauthorizedCrossDeviceMigration()
  if (blocked) return { linked: false, reason: blocked.reason }
  const d = String(deviceId ?? '').trim()
  if (await isCompletedTransferSourceDevice(d)) {
    return { linked: false, reason: 'transfer_revoked_source' }
  }
  const fpHash = hashDeviceFingerprint(fingerprint)
  if (!fpHash) return { linked: false, reason: 'no_fingerprint' }
  const rec = await recoverSubscriptionToDevice(deviceId, fpHash, { reason: 'verify_fast_fingerprint' })
  if (rec.recovered) {
    return { linked: true, method: 'fingerprint', ...rec }
  }
  return { linked: false, reason: rec.reason || 'no_match' }
}

/**
 * Find an active subscription row recoverable for this hardware fingerprint.
 * Matches direct fingerprint_hash on device_subscriptions OR trial registry rows with same fingerprint.
 */
async function findRecoverableSubscriptionRow(fpHash, excludeDeviceId, client) {
  const { rows } = await client.query(
    `SELECT ds.device_id, ds.expires_at, ds.status, ds.transaction_id
     FROM device_subscriptions ds
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND ds.device_id <> $2
       AND (
         ds.fingerprint_hash = $1
         OR ds.device_id IN (
           SELECT device_id FROM device_trial_entitlements
           WHERE fingerprint_hash = $1 AND fingerprint_hash <> ''
         )
       )
     ORDER BY ds.expires_at DESC
     LIMIT 1
     FOR UPDATE`,
    [fpHash, excludeDeviceId],
  )
  return rows[0] ?? null
}

/**
 * Move active subscription from source device to target device (APK reinstall / VPS migration).
 * Safe: no deletion; source row set to pending.
 */
export async function recoverSubscriptionToDevice(targetDeviceId, fpHash, { reason = 'auto_recover', ...opts } = {}) {
  const blocked = rejectUnauthorizedCrossDeviceMigration(opts)
  if (blocked) return blocked
  const target = String(targetDeviceId ?? '').trim()
  const hash = String(fpHash ?? '').trim()
  if (!target || !hash) {
    return { recovered: false, reason: 'missing_target_or_fingerprint' }
  }

  const pool = requirePool()
  const client = await pool.connect()
  try {
    const current = await getDeviceSubscriptionAccessState(target, null)
    if (current?.active_now === true && current?.blocked_now !== true) {
      return { recovered: false, reason: 'already_active' }
    }

    await client.query('BEGIN')
    const row = await findRecoverableSubscriptionRow(hash, target, client)
    if (!row) {
      await client.query('ROLLBACK')
      return { recovered: false, reason: 'no_recoverable_row' }
    }

    const sourceDeviceId = String(row.device_id || '').trim()
    if (await isReverseTransferMigrationBlocked(target, sourceDeviceId)) {
      await client.query('ROLLBACK')
      return { recovered: false, reason: 'transfer_revoked_source' }
    }
    const txnId = String(row.transaction_id || `recovery:${sourceDeviceId}`).trim()
    const freedSourceTxnId = `moved:${sourceDeviceId}:${txnId}`.slice(0, 240)

    if (sourceDeviceId && sourceDeviceId !== target) {
      await client.query(
        `UPDATE device_subscriptions
         SET status = 'pending',
             transaction_id = $2,
             updated_at = now()
         WHERE device_id = $1
           AND status = 'active'
           AND expires_at > now()`,
        [sourceDeviceId, freedSourceTxnId],
      )
    }

    const startedAt = row.started_at ?? new Date()
    await client.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash)
       VALUES ($1, 'active', $2, $3, $4, now(), $5)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         started_at = COALESCE(device_subscriptions.started_at, EXCLUDED.started_at),
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         fingerprint_hash = EXCLUDED.fingerprint_hash`,
      [target, row.expires_at, startedAt, txnId, hash],
    )
    await client.query('COMMIT')

    notifySubscriptionTransferred({
      sourceDeviceId: sourceDeviceId !== target ? sourceDeviceId : '',
      targetDeviceId: target,
      sourceRow:
        sourceDeviceId && sourceDeviceId !== target
          ? {
              device_id: sourceDeviceId,
              status: 'pending',
              expires_at: row.expires_at,
              active_now: false,
            }
          : null,
      targetRow: {
        device_id: target,
        status: 'active',
        expires_at: row.expires_at,
        active_now: true,
        transaction_id: txnId,
      },
      reason: 'recovery',
      userInitiatedTransfer: false,
    })

    console.log('[subscription-recover]', {
      reason,
      recovered_from: sourceDeviceId,
      recovered_to: target,
    })
    return { recovered: true, recovered_from: sourceDeviceId, recovered_to: target }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Link subscription when payment phone resolves to a different active device (no fingerprint required). */
export async function migrateSubscriptionFromSourceDevice(
  targetDeviceId,
  sourceDeviceId,
  fpHash = null,
  opts = {},
) {
  const target = String(targetDeviceId ?? '').trim()
  const source = String(sourceDeviceId ?? '').trim()
  const allowReverseTransfer = opts.allowReverseTransfer === true
  const blocked = rejectUnauthorizedCrossDeviceMigration(opts)
  if (blocked) return blocked
  if (!target || !source || target === source) {
    return { recovered: false, reason: 'invalid_devices' }
  }
  if (!allowReverseTransfer && (await isReverseTransferMigrationBlocked(target, source))) {
    return { recovered: false, reason: 'transfer_revoked_source' }
  }
  if (!allowReverseTransfer && (await isCompletedTransferSourceDevice(target))) {
    return { recovered: false, reason: 'transfer_revoked_source' }
  }
  if (!opts.allowRevokedTarget && (await isIntentionalMigrationRevokedDevice(target))) {
    return { recovered: false, reason: 'migration_revoked_target' }
  }

  const pool = requirePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT device_id, expires_at, started_at, status, transaction_id, fingerprint_hash
       FROM device_subscriptions
       WHERE device_id = $1 AND status = 'active' AND expires_at > now()
       LIMIT 1
       FOR UPDATE`,
      [source],
    )
    const row = rows[0]
    if (!row) {
      await client.query('ROLLBACK')
      return { recovered: false, reason: 'source_not_active' }
    }
    const hash = fpHash || String(row.fingerprint_hash || '').trim() || null
    const txnId = String(row.transaction_id || `recovery:${source}`).trim()
    const freedSourceTxnId = `moved:${source}:${txnId}`.slice(0, 240)

    await client.query(
      `UPDATE device_subscriptions
       SET status = 'pending',
           transaction_id = $2,
           updated_at = now()
       WHERE device_id = $1
         AND status = 'active'
         AND expires_at > now()`,
      [source, freedSourceTxnId],
    )
    const startedAt = row.started_at ?? new Date()
    await client.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash)
       VALUES ($1, 'active', $2, $3, $4, now(), $5)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         started_at = EXCLUDED.started_at,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         fingerprint_hash = COALESCE(EXCLUDED.fingerprint_hash, device_subscriptions.fingerprint_hash)`,
      [target, row.expires_at, startedAt, txnId, hash],
    )
    await client.query('COMMIT')
    notifySubscriptionTransferred({
      sourceDeviceId: source,
      targetDeviceId: target,
      sourceRow: {
        device_id: source,
        status: 'pending',
        expires_at: row.expires_at,
        active_now: false,
      },
      targetRow: {
        device_id: target,
        status: 'active',
        expires_at: row.expires_at,
        active_now: true,
        transaction_id: txnId,
      },
      reason: 'verify_payment_phone',
      userInitiatedTransfer: false,
    })
    return { recovered: true, recovered_from: source, recovered_to: target }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Tag active subscription with fingerprint for future recoveries (non-destructive). */
export async function tagActiveSubscriptionFingerprint(deviceId, fingerprint) {
  const fpHash = hashDeviceFingerprint(fingerprint)
  const d = String(deviceId ?? '').trim()
  if (!d || !fpHash) return { tagged: false }
  const pool = requirePool()
  const { rowCount } = await pool.query(
    `UPDATE device_subscriptions
     SET fingerprint_hash = $2, updated_at = now()
     WHERE device_id = $1
       AND status = 'active'
       AND expires_at > now()
       AND (fingerprint_hash IS NULL OR fingerprint_hash = '')`,
    [d, fpHash],
  )
  return { tagged: Number(rowCount) > 0 }
}

/** Collect normalized payment phones known for this device (txns, registry, resolver). */
async function collectPaymentPhonesForDevice(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return []
  const phones = new Set()
  const add = (raw) => {
    const digits = normalizePhoneDigits(raw)
    if (digits && digits.length >= 10) phones.add(digits)
  }

  const resolved = await resolvePaymentPhoneForDevice(d)
  if (resolved?.phone) add(resolved.phone)

  const intel = await getDeviceIntelligenceByDeviceId(d)
  if (intel?.phoneNumber) add(intel.phoneNumber)
  if (intel?.accountId) add(intel.accountId)

  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT DISTINCT phone::text AS phone
     FROM transactions
     WHERE device_id = $1
       AND trim(coalesce(phone::text, '')) <> ''
     ORDER BY phone`,
    [d],
  )
  for (const row of rows) add(row.phone)
  return [...phones]
}

/** Active sub on another device sharing the same hardware android_id (VPS APK reinstall). */
async function findActiveDeviceIdBySharedAndroidId(targetDeviceId) {
  const target = String(targetDeviceId ?? '').trim()
  if (!target) return null
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT ds.device_id::text AS device_id
     FROM device_subscriptions ds
     INNER JOIN device_intelligence_registry ir_src ON ir_src.device_id = ds.device_id
     INNER JOIN device_intelligence_registry ir_tgt ON ir_tgt.device_id = $1
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND ds.device_id <> $1
       AND trim(coalesce(ir_src.android_id, '')) <> ''
       AND ir_src.android_id = ir_tgt.android_id
     ORDER BY ds.expires_at DESC
     LIMIT 1`,
    [target],
  )
  const candidate = rows[0]?.device_id ? String(rows[0].device_id) : null
  if (!candidate) return null
  if (await isReverseTransferMigrationBlocked(target, candidate)) return null
  return candidate
}

/** Resolve active subscription device_id from legacy/displayed account prefix (e.g. C0972049 → c0972049aa5f862e). */
async function resolveActiveDeviceIdByLegacyHint(hint, excludeDeviceId) {
  const prefix = normalizeLegacyDeviceHint(hint)
  const exclude = String(excludeDeviceId ?? '').trim()
  if (!prefix) return null
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT ds.device_id::text AS device_id
     FROM device_subscriptions ds
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND lower(ds.device_id) LIKE $1 || '%'
       AND ds.device_id <> $2
     ORDER BY length(ds.device_id) ASC, ds.expires_at DESC
     LIMIT 2`,
    [prefix, exclude],
  )
  if (rows.length !== 1) return null
  const candidate = String(rows[0].device_id)
  if (await isReverseTransferMigrationBlocked(exclude, candidate)) return null
  return candidate
}

/** Exactly one active subscription linked to this phone via intelligence registry. */
async function findUniqueActiveDeviceIdByIntelligencePhone(phoneInput, excludeDeviceId) {
  const digits = normalizePhoneDigits(phoneInput)
  const exclude = String(excludeDeviceId ?? '').trim()
  if (!digits || digits.length < 10) return null
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT ds.device_id::text AS device_id
     FROM device_subscriptions ds
     INNER JOIN device_intelligence_registry ir ON ir.device_id = ds.device_id
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND ds.device_id <> $2
       AND (
         ${phoneCanonicalSql('ir.phone_number')} = $1
         OR ${phoneCanonicalSql('ir.account_id')} = $1
       )
     ORDER BY ds.expires_at DESC
     LIMIT 3`,
    [digits, exclude],
  )
  if (rows.length !== 1) return null
  const candidate = String(rows[0].device_id)
  if (await isReverseTransferMigrationBlocked(exclude, candidate)) return null
  return candidate
}

/** Exactly one active subscription tied to payment phone cluster (safe when unambiguous). */
async function findUniqueActiveDeviceIdForPhoneCluster(phones, excludeDeviceId) {
  const exclude = String(excludeDeviceId ?? '').trim()
  const sources = new Set()
  for (const phone of phones) {
    const sourceId = await findActiveDeviceIdForPaymentPhone(phone, { proofDeviceId: exclude })
    if (sourceId && sourceId !== exclude) sources.add(sourceId)
  }
  if (sources.size !== 1) return null
  return [...sources][0]
}

/** Shared install_instance_id across APK reinstalls (app_installs registry). */
async function findActiveDeviceIdBySharedInstallInstance(targetDeviceId) {
  const target = String(targetDeviceId ?? '').trim()
  if (!target) return null
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT ds.device_id::text AS device_id
     FROM app_installs ai_tgt
     INNER JOIN app_installs ai_src
       ON ai_src.install_instance_id = ai_tgt.install_instance_id
      AND trim(ai_src.install_instance_id) <> ''
      AND ai_src.device_id <> ai_tgt.device_id
     INNER JOIN device_subscriptions ds
       ON ds.device_id = ai_src.device_id
      AND ds.status = 'active'
      AND ds.expires_at > now()
     WHERE ai_tgt.device_id = $1
     ORDER BY ds.expires_at DESC
     LIMIT 2`,
    [target],
  )
  if (rows.length !== 1) return null
  const candidate = String(rows[0].device_id)
  if (await isReverseTransferMigrationBlocked(target, candidate)) return null
  return candidate
}

async function resolveFingerprintForDevice(deviceId, explicitFingerprint) {
  const fp = String(explicitFingerprint ?? '').trim()
  if (fp) return fp
  const intel = await getDeviceIntelligenceByDeviceId(deviceId)
  return String(intel?.deviceFingerprint ?? '').trim() || null
}

async function tryLinkFromSource(target, sourceId, fpHash, method, opts = {}) {
  if (!sourceId || sourceId === target) return { linked: false, reason: 'no_source' }
  if (!opts.allowReverseTransfer && (await isReverseTransferMigrationBlocked(target, sourceId))) {
    return { linked: false, reason: 'transfer_revoked_source' }
  }
  const migrated = await migrateSubscriptionFromSourceDevice(target, sourceId, fpHash, opts)
  if (migrated.recovered) {
    return { linked: true, method, recovered_from: migrated.recovered_from, recovered_to: migrated.recovered_to }
  }
  return { linked: false, reason: migrated.reason || 'migrate_failed' }
}

/**
 * APK migration / reinstall: recover by fingerprint, legacy device id, payment phone, android_id, install registry.
 */
export async function ensureSubscriptionLinkedForDevice(
  deviceId,
  { fingerprint = null, phone = null, legacyDeviceId = null, accountId = null } = {},
) {
  const d = String(deviceId ?? '').trim()
  if (!d) return { linked: false, reason: 'missing_device_id' }
  if (await isCompletedTransferSourceDevice(d)) {
    return { linked: false, reason: 'transfer_revoked_source' }
  }

  const state = await getDeviceSubscriptionAccessState(d, fingerprint)
  if (state?.active_now === true && state?.blocked_now !== true) {
    const fpForTag = await resolveFingerprintForDevice(d, fingerprint)
    if (fpForTag) await tagActiveSubscriptionFingerprint(d, fpForTag)
    return { linked: false, reason: 'already_active' }
  }

  const resolvedFingerprint = await resolveFingerprintForDevice(d, fingerprint)
  const blocked = rejectUnauthorizedCrossDeviceMigration()
  if (blocked) {
    if (resolvedFingerprint) await tagActiveSubscriptionFingerprint(d, resolvedFingerprint)
    return { linked: false, reason: blocked.reason }
  }

  if (resolvedFingerprint) await tagActiveSubscriptionFingerprint(d, resolvedFingerprint)
  return { linked: false, reason: 'no_match' }
}
