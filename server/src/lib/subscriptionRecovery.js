import { getPool } from '../db/pool.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { liveSyncBus } from './liveSyncBus.js'
import {
  findActiveDeviceIdForPaymentPhone,
  getDeviceSubscriptionAccessState,
  hashDeviceFingerprint,
  normalizePhoneDigits,
  resolvePaymentPhoneForDevice,
} from '../billingStore.js'
import { getDeviceIntelligenceByDeviceId } from './deviceIntelligenceStore.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
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
export async function recoverSubscriptionToDevice(targetDeviceId, fpHash, { reason = 'auto_recover' } = {}) {
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
    await client.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash)
       VALUES ($1, 'active', $2, now(), $3, now(), $4)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         fingerprint_hash = EXCLUDED.fingerprint_hash`,
      [target, row.expires_at, row.transaction_id || `recovery:${sourceDeviceId}`, hash],
    )
    if (sourceDeviceId && sourceDeviceId !== target) {
      await client.query(
        `UPDATE device_subscriptions SET status = 'pending', updated_at = now() WHERE device_id = $1`,
        [sourceDeviceId],
      )
    }
    await client.query('COMMIT')

    if (sourceDeviceId && sourceDeviceId !== target) {
      deviceSubscriptionBus.emit('update', { deviceId: sourceDeviceId })
    }
    deviceSubscriptionBus.emit('update', { deviceId: target })
    liveSyncBus.publish('analytics.subscription_updated', {
      topics: ['analytics'],
      deviceId: target,
      orderId: `recovery:${sourceDeviceId}`,
      reason,
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
export async function migrateSubscriptionFromSourceDevice(targetDeviceId, sourceDeviceId, fpHash = null) {
  const target = String(targetDeviceId ?? '').trim()
  const source = String(sourceDeviceId ?? '').trim()
  if (!target || !source || target === source) {
    return { recovered: false, reason: 'invalid_devices' }
  }

  const pool = requirePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT device_id, expires_at, status, transaction_id, fingerprint_hash
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
    await client.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash)
       VALUES ($1, 'active', $2, now(), $3, now(), $4)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         fingerprint_hash = COALESCE(EXCLUDED.fingerprint_hash, device_subscriptions.fingerprint_hash)`,
      [target, row.expires_at, row.transaction_id || `recovery:${source}`, hash],
    )
    await client.query(
      `UPDATE device_subscriptions SET status = 'pending', updated_at = now() WHERE device_id = $1`,
      [source],
    )
    await client.query('COMMIT')
    deviceSubscriptionBus.emit('update', { deviceId: source })
    deviceSubscriptionBus.emit('update', { deviceId: target })
    liveSyncBus.publish('analytics.subscription_updated', {
      topics: ['analytics'],
      deviceId: target,
      orderId: `recovery:${source}`,
      reason: 'verify_payment_phone',
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
  return rows[0]?.device_id ? String(rows[0].device_id) : null
}

async function tryLinkFromSource(target, sourceId, fpHash, method) {
  if (!sourceId || sourceId === target) return { linked: false, reason: 'no_source' }
  const migrated = await migrateSubscriptionFromSourceDevice(target, sourceId, fpHash)
  if (migrated.recovered) {
    return { linked: true, method, recovered_from: migrated.recovered_from, recovered_to: migrated.recovered_to }
  }
  return { linked: false, reason: migrated.reason || 'migrate_failed' }
}

/**
 * APK migration / reinstall: recover by fingerprint, else link by payment phone if provided.
 */
export async function ensureSubscriptionLinkedForDevice(deviceId, { fingerprint = null, phone = null } = {}) {
  const d = String(deviceId ?? '').trim()
  if (!d) return { linked: false, reason: 'missing_device_id' }

  const state = await getDeviceSubscriptionAccessState(d, fingerprint)
  if (state?.active_now === true && state?.blocked_now !== true) {
    if (fingerprint) await tagActiveSubscriptionFingerprint(d, fingerprint)
    return { linked: false, reason: 'already_active' }
  }

  const fpHash = hashDeviceFingerprint(fingerprint)
  if (fpHash) {
    const rec = await recoverSubscriptionToDevice(d, fpHash, { reason: 'verify_fingerprint' })
    if (rec.recovered) return { linked: true, method: 'fingerprint', ...rec }
  }

  const phoneCandidates = new Set()
  const explicit = normalizePhoneDigits(phone)
  if (explicit && explicit.length >= 10) phoneCandidates.add(explicit)
  for (const p of await collectPaymentPhonesForDevice(d)) phoneCandidates.add(p)

  for (const digits of phoneCandidates) {
    const sourceId = await findActiveDeviceIdForPaymentPhone(digits, { proofDeviceId: d })
    if (sourceId && sourceId !== d) {
      const linked = await tryLinkFromSource(d, sourceId, fpHash, 'payment_phone')
      if (linked.linked) return linked
    }
  }

  const androidSource = await findActiveDeviceIdBySharedAndroidId(d)
  if (androidSource) {
    const linked = await tryLinkFromSource(d, androidSource, fpHash, 'android_id')
    if (linked.linked) return linked
  }

  if (fingerprint) await tagActiveSubscriptionFingerprint(d, fingerprint)
  return { linked: false, reason: 'no_match' }
}
