import crypto from 'node:crypto'
import { getPool } from '../db/pool.js'
import { normalizePhoneDigits, setManualAdminBlocked } from '../billingStore.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

function rowToRegistry(r) {
  if (!r) return null
  return {
    id: r.id,
    accountId: r.account_id,
    userId: r.user_id,
    deviceId: r.device_id,
    deviceFingerprint: r.device_fingerprint,
    androidId: r.android_id,
    deviceModel: r.device_model,
    deviceBrand: r.device_brand,
    osVersion: r.os_version,
    appVersion: r.app_version,
    phoneNumber: r.phone_number,
    firstSeenAt: r.first_seen_at,
    lastSeenAt: r.last_seen_at,
    status: r.status,
    blockReason: r.block_reason,
    blockedBy: r.blocked_by,
    blockedAt: r.blocked_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }
}

function deviceFieldsChanged(prev, next) {
  const keys = [
    ['device_fingerprint', 'deviceFingerprint'],
    ['android_id', 'androidId'],
    ['device_model', 'deviceModel'],
    ['device_brand', 'deviceBrand'],
    ['os_version', 'osVersion'],
    ['app_version', 'appVersion'],
  ]
  for (const [dbKey, payloadKey] of keys) {
    const a = String(prev?.[dbKey] ?? '').trim()
    const b = String(next?.[payloadKey] ?? next?.[dbKey] ?? '').trim()
    if (a !== b && b) return true
  }
  return false
}

function summarizeDeviceChange(prev, payload) {
  const parts = []
  if (prev.device_fingerprint !== payload.deviceFingerprint && payload.deviceFingerprint) {
    parts.push('fingerprint')
  }
  if (prev.android_id !== payload.androidId && payload.androidId) parts.push('android_id')
  if (prev.device_model !== payload.deviceModel && payload.deviceModel) parts.push('model')
  if (prev.app_version !== payload.appVersion && payload.appVersion) parts.push('app_version')
  return parts.length ? parts.join(', ') : 'heartbeat'
}

function buildPushMetadataPatch(payload) {
  const pushSubscriptionId = String(
    payload.pushSubscriptionId ?? payload.push_subscription_id ?? '',
  ).trim()
  const onesignalId = String(payload.onesignalId ?? payload.onesignal_id ?? '').trim()
  const pushOptedIn = payload.pushOptedIn ?? payload.push_opted_in
  const pushPermission = payload.pushPermission ?? payload.push_permission
  const nativeVersionCode = payload.nativeVersionCode ?? payload.native_version_code
  const patch = { push_registered_at: new Date().toISOString() }
  if (pushSubscriptionId) patch.push_subscription_id = pushSubscriptionId
  if (onesignalId) patch.onesignal_id = onesignalId
  if (pushOptedIn != null) patch.push_opted_in = pushOptedIn === true
  if (pushPermission != null) patch.push_permission = pushPermission === true
  if (nativeVersionCode != null && String(nativeVersionCode).trim() !== '') {
    patch.native_version_code = Number(nativeVersionCode) || String(nativeVersionCode).trim()
  }
  return patch
}

function mergeRegistryMetadata(existingMetadata, payload) {
  const base =
    existingMetadata && typeof existingMetadata === 'object' && !Array.isArray(existingMetadata)
      ? existingMetadata
      : {}
  const pushPatch = buildPushMetadataPatch(payload)
  const extra =
    payload.metadata && typeof payload.metadata === 'object' && !Array.isArray(payload.metadata)
      ? payload.metadata
      : {}
  return { ...base, ...extra, push: { ...(base.push || {}), ...pushPatch } }
}

export async function getDeviceIntelligenceSummary() {
  const pool = requirePool()
  const { rows } = await pool.query(`
    SELECT
      count(*)::int AS total_ever,
      count(*) FILTER (WHERE status = 'active')::int AS active,
      count(*) FILTER (WHERE status = 'blocked')::int AS blocked,
      count(*) FILTER (WHERE status = 'inactive')::int AS inactive
    FROM device_intelligence_registry
  `)
  const s = rows[0] || {}
  return {
    totalDevicesEverSeen: s.total_ever ?? 0,
    activeDevices: s.active ?? 0,
    blockedDevices: s.blocked ?? 0,
    inactiveDevices: s.inactive ?? 0,
  }
}

export async function listDeviceIntelligenceRegistry({ q, limit = 100, offset = 0 } = {}) {
  const pool = requirePool()
  const term = String(q ?? '').trim()
  const params = []
  let where = ''
  if (term) {
    const phone = normalizePhoneDigits(term)
    params.push(`%${term}%`)
    const p1 = params.length
    params.push(`%${term}%`)
    const p2 = params.length
    params.push(`%${term}%`)
    const p3 = params.length
    const phoneClause = phone
      ? ` OR phone_number = $${params.length + 1} OR account_id = $${params.length + 1}
          OR device_id IN (
            SELECT device_id::text FROM device_phone_registry
            WHERE phone_number_normalized = $${params.length + 1}
          )`
      : ''
    if (phone) params.push(phone)
    where = `WHERE (
      device_id ILIKE $${p1}
      OR account_id ILIKE $${p2}
      OR user_id ILIKE $${p3}
      OR device_fingerprint ILIKE $${p1}
      OR android_id ILIKE $${p1}
      ${phoneClause}
    )`
  }
  params.push(Math.min(500, Math.max(1, Number(limit) || 100)))
  const lim = params.length
  params.push(Math.max(0, Number(offset) || 0))
  const off = params.length

  const { rows } = await pool.query(
    `SELECT * FROM device_intelligence_registry
     ${where}
     ORDER BY last_seen_at DESC NULLS LAST
     LIMIT $${lim} OFFSET $${off}`,
    params,
  )
  return rows.map(rowToRegistry)
}

export async function getDeviceIntelligenceById(id) {
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT * FROM device_intelligence_registry WHERE id = $1::uuid`, [id])
  return rowToRegistry(rows[0])
}

export async function getDeviceIntelligenceByDeviceId(deviceId) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT * FROM device_intelligence_registry WHERE device_id = $1 LIMIT 1`,
    [String(deviceId ?? '').trim()],
  )
  return rowToRegistry(rows[0])
}

export async function registerDeviceIntelligence(payload, meta = {}) {
  const pool = requirePool()
  const deviceId = String(payload.deviceId ?? payload.device_id ?? '').trim()
  if (!deviceId) throw new Error('device_id is required')

  const phone = payload.phoneNumber ?? payload.phone ?? payload.phone_number ?? ''
  const phoneDigits = normalizePhoneDigits(phone)
  const accountId = String(
    payload.accountId ?? payload.account_id ?? (phoneDigits || ''),
  ).trim()
  let userId = String(payload.userId ?? payload.user_id ?? '').trim()
  if (!userId) userId = crypto.randomUUID()

  const fields = {
    deviceFingerprint: String(payload.deviceFingerprint ?? payload.device_fingerprint ?? '').trim(),
    androidId: String(payload.androidId ?? payload.android_id ?? '').trim(),
    deviceModel: String(payload.deviceModel ?? payload.device_model ?? '').trim(),
    deviceBrand: String(payload.deviceBrand ?? payload.device_brand ?? '').trim(),
    osVersion: String(payload.osVersion ?? payload.os_version ?? '').trim(),
    appVersion: String(payload.appVersion ?? payload.app_version ?? '').trim(),
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const existing = await client.query(
      `SELECT * FROM device_intelligence_registry WHERE device_id = $1 FOR UPDATE`,
      [deviceId],
    )
    const prev = existing.rows[0]
    let registry
    const now = new Date()

    if (!prev) {
      const metadata = mergeRegistryMetadata(null, payload)
      const ins = await client.query(
        `INSERT INTO device_intelligence_registry (
          account_id, user_id, device_id, device_fingerprint, android_id,
          device_model, device_brand, os_version, app_version, phone_number,
          first_seen_at, last_seen_at, status, metadata, updated_at
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,'active',$12::jsonb,$11)
        RETURNING *`,
        [
          accountId,
          userId,
          deviceId,
          fields.deviceFingerprint,
          fields.androidId,
          fields.deviceModel,
          fields.deviceBrand,
          fields.osVersion,
          fields.appVersion,
          phoneDigits,
          now,
          JSON.stringify(metadata),
        ],
      )
      registry = ins.rows[0]
      await client.query(
        `INSERT INTO device_intelligence_login_log
         (registry_id, device_id, account_id, event_type, ip_address, app_version, user_agent)
         VALUES ($1,$2,$3,'register',$4,$5,$6)`,
        [
          registry.id,
          deviceId,
          accountId,
          String(meta.ip ?? ''),
          fields.appVersion,
          String(meta.userAgent ?? ''),
        ],
      )
      await client.query(
        `INSERT INTO device_intelligence_device_history (
          registry_id, device_id, device_fingerprint, android_id, device_model,
          device_brand, os_version, app_version, change_summary
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'initial_registration')`,
        [
          registry.id,
          deviceId,
          fields.deviceFingerprint,
          fields.androidId,
          fields.deviceModel,
          fields.deviceBrand,
          fields.osVersion,
          fields.appVersion,
        ],
      )
    } else {
      const status = prev.status === 'inactive' ? 'active' : prev.status
      const metadata = mergeRegistryMetadata(prev.metadata, payload)
      const upd = await client.query(
        `UPDATE device_intelligence_registry SET
          account_id = CASE WHEN $2 <> '' THEN $2 ELSE account_id END,
          user_id = CASE WHEN $3 <> '' THEN $3 ELSE user_id END,
          device_fingerprint = CASE WHEN $4 <> '' THEN $4 ELSE device_fingerprint END,
          android_id = CASE WHEN $5 <> '' THEN $5 ELSE android_id END,
          device_model = CASE WHEN $6 <> '' THEN $6 ELSE device_model END,
          device_brand = CASE WHEN $7 <> '' THEN $7 ELSE device_brand END,
          os_version = CASE WHEN $8 <> '' THEN $8 ELSE os_version END,
          app_version = CASE WHEN $9 <> '' THEN $9 ELSE app_version END,
          phone_number = CASE WHEN $10 <> '' THEN $10 ELSE phone_number END,
          last_seen_at = $11,
          status = $12,
          metadata = $13::jsonb,
          updated_at = $11
        WHERE device_id = $1
        RETURNING *`,
        [
          deviceId,
          accountId,
          userId,
          fields.deviceFingerprint,
          fields.androidId,
          fields.deviceModel,
          fields.deviceBrand,
          fields.osVersion,
          fields.appVersion,
          phoneDigits,
          now,
          status,
          JSON.stringify(metadata),
        ],
      )
      registry = upd.rows[0]
      if (!registry) {
        throw new Error(`device registry update failed for ${deviceId}`)
      }
      const eventType = prev.status === 'blocked' ? 'blocked_attempt' : 'heartbeat'
      await client.query(
        `INSERT INTO device_intelligence_login_log
         (registry_id, device_id, account_id, event_type, ip_address, app_version, user_agent)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          registry.id,
          deviceId,
          registry.account_id,
          eventType,
          String(meta.ip ?? ''),
          fields.appVersion || registry.app_version,
          String(meta.userAgent ?? ''),
        ],
      )
      if (deviceFieldsChanged(prev, fields)) {
        await client.query(
          `INSERT INTO device_intelligence_device_history (
            registry_id, device_id, device_fingerprint, android_id, device_model,
            device_brand, os_version, app_version, change_summary
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            registry.id,
            deviceId,
            fields.deviceFingerprint || prev.device_fingerprint,
            fields.androidId || prev.android_id,
            fields.deviceModel || prev.device_model,
            fields.deviceBrand || prev.device_brand,
            fields.osVersion || prev.os_version,
            fields.appVersion || prev.app_version,
            summarizeDeviceChange(prev, fields),
          ],
        )
      }
    }
    await client.query('COMMIT')
    const out = rowToRegistry(registry)
    return {
      ...out,
      blocked: out.status === 'blocked',
      allowed: out.status !== 'blocked',
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Apply Users Intelligence block to subscription verify path (manual_admin_blocked). */
export async function syncIntelligenceBlockToPlayback(deviceId, blocked) {
  const d = String(deviceId ?? '').trim()
  if (!d) return { ok: false, reason: 'device_id required' }
  await setManualAdminBlocked(d, Boolean(blocked))
  deviceSubscriptionBus.emit('update', { deviceId: d, source: 'users_intelligence' })
  return { ok: true, deviceId: d, blocked: Boolean(blocked) }
}

/** Repair: registry blocked rows → device_subscriptions.manual_admin_blocked */
export async function syncAllIntelligenceBlocksToPlayback() {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT device_id FROM device_intelligence_registry WHERE status = 'blocked'`,
  )
  let synced = 0
  for (const row of rows) {
    await syncIntelligenceBlockToPlayback(row.device_id, true)
    synced += 1
  }
  return { synced }
}

export async function blockDeviceIntelligenceUser(id, { reason, adminEmail }) {
  const pool = requirePool()
  const r = String(reason ?? '').trim()
  if (!r) throw new Error('block reason is required')
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE device_intelligence_registry SET
        status = 'blocked',
        block_reason = $2,
        blocked_by = $3,
        blocked_at = now(),
        updated_at = now()
      WHERE id = $1::uuid
      RETURNING *`,
      [id, r, String(adminEmail ?? 'admin')],
    )
    const reg = rows[0]
    if (!reg) {
      await client.query('ROLLBACK')
      return null
    }
    await client.query(
      `INSERT INTO device_intelligence_admin_actions
       (registry_id, device_id, action, reason, admin_email)
       VALUES ($1,$2,'block',$3,$4)`,
      [reg.id, reg.device_id, r, String(adminEmail ?? 'admin')],
    )
    await client.query(
      `INSERT INTO device_intelligence_login_log
       (registry_id, device_id, account_id, event_type, app_version)
       VALUES ($1,$2,$3,'blocked_attempt',$4)`,
      [reg.id, reg.device_id, reg.account_id, reg.app_version],
    )
    await client.query('COMMIT')
    await syncIntelligenceBlockToPlayback(reg.device_id, true)
    return rowToRegistry(reg)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/** Clear Users Intelligence block for all registry rows tied to a device_id. */
export async function unblockDeviceIntelligenceByDeviceId(deviceId, { adminEmail, note } = {}) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return { updated: 0 }
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE device_intelligence_registry SET
        status = 'active',
        block_reason = '',
        blocked_by = '',
        blocked_at = NULL,
        updated_at = now()
      WHERE device_id = $1 AND status = 'blocked'
      RETURNING id, device_id`,
      [d],
    )
    for (const reg of rows) {
      await client.query(
        `INSERT INTO device_intelligence_admin_actions
         (registry_id, device_id, action, reason, admin_email)
         VALUES ($1,$2,'unblock',$3,$4)`,
        [reg.id, reg.device_id, String(note ?? ''), String(adminEmail ?? 'admin')],
      )
    }
    await client.query('COMMIT')
    if (rows.length > 0) {
      await syncIntelligenceBlockToPlayback(d, false)
    }
    return { updated: rows.length }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function unblockDeviceIntelligenceUser(id, { adminEmail, note } = {}) {
  const pool = requirePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `UPDATE device_intelligence_registry SET
        status = 'active',
        block_reason = '',
        blocked_by = '',
        blocked_at = NULL,
        updated_at = now()
      WHERE id = $1::uuid
      RETURNING *`,
      [id],
    )
    const reg = rows[0]
    if (!reg) {
      await client.query('ROLLBACK')
      return null
    }
    await client.query(
      `INSERT INTO device_intelligence_admin_actions
       (registry_id, device_id, action, reason, admin_email)
       VALUES ($1,$2,'unblock',$3,$4)`,
      [reg.id, reg.device_id, String(note ?? ''), String(adminEmail ?? 'admin')],
    )
    await client.query('COMMIT')
    await syncIntelligenceBlockToPlayback(reg.device_id, false)
    return rowToRegistry(reg)
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function getDeviceIntelligenceDetailBundle(id) {
  const pool = requirePool()
  const registry = await getDeviceIntelligenceById(id)
  if (!registry) return null

  const deviceId = registry.deviceId
  const phone = registry.phoneNumber || registry.accountId

  const [
    securityProfile,
    payments,
    deviceSub,
    manualGrants,
    transfersOut,
    transfersIn,
    loginLog,
    deviceHistory,
    adminActions,
  ] = await Promise.all([
    pool.query(`SELECT * FROM device_security_profiles WHERE device_id = $1`, [deviceId]),
    pool.query(
      `SELECT t.id, t.order_id, t.plan_id, t.phone, t.amount, t.currency, t.status,
              t.device_id, t.created_at, t.updated_at, p.name AS plan_name
       FROM transactions t
       LEFT JOIN plans p ON p.id = t.plan_id
       WHERE t.device_id = $1
          OR ($2 <> '' AND t.phone = $2)
       ORDER BY t.created_at DESC
       LIMIT 200`,
      [deviceId, phone],
    ),
    pool.query(`SELECT * FROM device_subscriptions WHERE device_id = $1`, [deviceId]),
    pool.query(
      `SELECT g.*, p.name AS plan_name
       FROM manual_subscription_grants g
       LEFT JOIN device_subscriptions ds ON ds.device_id = g.device_id
       LEFT JOIN transactions t ON t.order_id = ds.transaction_id
       LEFT JOIN plans p ON p.id = t.plan_id
       WHERE g.device_id = $1 AND g.deleted_at IS NULL
       ORDER BY g.created_at DESC
       LIMIT 100`,
      [deviceId],
    ),
    pool.query(
      `SELECT dt.*, tc.code AS transfer_code
       FROM device_transfers dt
       LEFT JOIN transfer_codes tc ON tc.id = dt.code_id
       WHERE dt.source_device_id = $1
       ORDER BY dt.created_at DESC
       LIMIT 100`,
      [deviceId],
    ),
    pool.query(
      `SELECT dt.*, tc.code AS transfer_code
       FROM device_transfers dt
       LEFT JOIN transfer_codes tc ON tc.id = dt.code_id
       WHERE dt.target_device_id = $1
       ORDER BY dt.created_at DESC
       LIMIT 100`,
      [deviceId],
    ),
    pool.query(
      `SELECT * FROM device_intelligence_login_log
       WHERE registry_id = $1::uuid OR device_id = $2
       ORDER BY created_at DESC
       LIMIT 200`,
      [id, deviceId],
    ),
    pool.query(
      `SELECT * FROM device_intelligence_device_history
       WHERE registry_id = $1::uuid
       ORDER BY recorded_at DESC
       LIMIT 200`,
      [id],
    ),
    pool.query(
      `SELECT * FROM device_intelligence_admin_actions
       WHERE registry_id = $1::uuid OR device_id = $2
       ORDER BY created_at DESC
       LIMIT 100`,
      [id, deviceId],
    ),
  ])

  let phoneSubscription = null
  if (phone) {
    const sub = await pool.query(
      `SELECT s.*, p.name AS plan_name FROM subscriptions s
       LEFT JOIN plans p ON p.id = s.plan_id
       WHERE s.phone = $1`,
      [phone],
    )
    phoneSubscription = sub.rows[0] ?? null
  }

  const sp = securityProfile.rows[0]
  return {
    registry,
    account: {
      accountId: registry.accountId,
      userId: registry.userId,
      phoneNumber: registry.phoneNumber,
      phoneSubscription,
      securityProfile: sp
        ? {
            phoneUser: sp.phone_user,
            securityLevel: sp.security_level,
            adminStatus: sp.admin_status,
            firstSeenAt: sp.first_seen_at,
            lastSeenAt: sp.last_seen_at,
          }
        : null,
    },
    device: {
      deviceId: registry.deviceId,
      deviceFingerprint: registry.deviceFingerprint,
      androidId: registry.androidId,
      deviceModel: registry.deviceModel,
      deviceBrand: registry.deviceBrand,
      osVersion: registry.osVersion,
      appVersion: registry.appVersion,
      status: registry.status,
      blockReason: registry.blockReason,
      blockedBy: registry.blockedBy,
      blockedAt: registry.blockedAt,
      firstSeenAt: registry.firstSeenAt,
      lastSeenAt: registry.lastSeenAt,
      subscription: deviceSub.rows[0] ?? null,
    },
    paymentHistory: payments.rows,
    packagePurchases: deviceSub.rows,
    packageTransferHistory: transfersOut.rows,
    receivedTransfers: transfersIn.rows,
    manualGrants: manualGrants.rows,
    loginActivity: loginLog.rows,
    deviceHistory: deviceHistory.rows,
    adminActions: adminActions.rows,
  }
}

/** One-time seed from existing device_subscriptions + security profiles (additive). */
export async function backfillDeviceIntelligenceFromExisting() {
  const pool = requirePool()
  const { rows } = await pool.query(`
    SELECT
      ds.device_id,
      COALESCE(ds.fingerprint_hash, '') AS fingerprint_hash,
      COALESCE(dsp.phone_user, '') AS phone_user,
      COALESCE(dsp.app_version, '') AS app_version,
      COALESCE(dsp.first_seen_at, ds.started_at, now()) AS first_seen_at,
      COALESCE(dsp.last_seen_at, ds.updated_at, now()) AS last_seen_at,
      COALESCE(dsp.metadata->>'device_model', '') AS device_model,
      COALESCE(dsp.metadata->>'device_brand', '') AS device_brand,
      COALESCE(dsp.metadata->>'os_version', '') AS os_version,
      COALESCE(dsp.metadata->>'android_id', '') AS android_id
    FROM device_subscriptions ds
    LEFT JOIN device_security_profiles dsp ON dsp.device_id = ds.device_id
    WHERE NOT EXISTS (
      SELECT 1 FROM device_intelligence_registry r WHERE r.device_id = ds.device_id
    )
    LIMIT 5000
  `)

  let inserted = 0
  for (const row of rows) {
    const phone = normalizePhoneDigits(row.phone_user)
    try {
      await pool.query(
        `INSERT INTO device_intelligence_registry (
          account_id, user_id, device_id, device_fingerprint, android_id,
          device_model, device_brand, os_version, app_version, phone_number,
          first_seen_at, last_seen_at, status
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'active')
        ON CONFLICT (device_id) DO NOTHING`,
        [
          phone,
          crypto.randomUUID(),
          row.device_id,
          row.fingerprint_hash || '',
          row.android_id || '',
          row.device_model || '',
          row.device_brand || '',
          row.os_version || '',
          row.app_version || '',
          phone,
          row.first_seen_at,
          row.last_seen_at,
        ],
      )
      inserted += 1
    } catch (e) {
      console.warn('[device_intelligence backfill] skip', row.device_id, e?.message)
    }
  }
  return { scanned: rows.length, inserted }
}
