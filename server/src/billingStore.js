import crypto from 'node:crypto'
import { ensureBillingTables } from './db/billingTables.js'
import { getPool } from './db/pool.js'

export async function ensureBillingStorage() {
  const pool = getPool()
  if (!pool) {
    throw new Error('DATABASE_URL is required for billing (plans, transactions, ZenoPay).')
  }
  const client = await pool.connect()
  try {
    await ensureBillingTables(client)
  } finally {
    client.release()
  }
}

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

function sanitizePresenceText(v, max = 120) {
  const s = String(v ?? '').trim()
  if (!s) return null
  return s.slice(0, max)
}

/** --- Plans --- */

export async function listPlansWithSubscriberCounts() {
  const pool = requirePool()
  const { rows } = await pool.query(`
    SELECT p.*,
           COALESCE(s.cnt, 0)::int AS active_subscriber_count
    FROM plans p
    LEFT JOIN (
      SELECT plan_id, COUNT(*)::int AS cnt
      FROM subscriptions
      WHERE expires_at > now()
      GROUP BY plan_id
    ) s ON s.plan_id = p.id
    WHERE p.deleted_at IS NULL
    ORDER BY p.id ASC
  `)
  return rows
}

export async function getPlanById(id) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT * FROM plans WHERE id = $1 AND deleted_at IS NULL`,
    [Number(id)],
  )
  return rows[0] ?? null
}

/** Includes soft-deleted plans (for webhooks / historical TX). */
export async function getPlanRowByIdAny(id) {
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT * FROM plans WHERE id = $1`, [Number(id)])
  return rows[0] ?? null
}

export async function insertPlan(payload) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `INSERT INTO plans (name, price, duration_days, expiry_type, fixed_expiry_time, is_active)
     VALUES ($1, $2, $3, $4, $5::time, $6)
     RETURNING *`,
    [
      payload.name,
      payload.price,
      payload.duration_days,
      payload.expiry_type,
      payload.fixed_expiry_time,
      payload.is_active,
    ],
  )
  return rows[0]
}

export async function updatePlan(id, payload) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `UPDATE plans SET
       name = $2, price = $3, duration_days = $4, expiry_type = $5,
       fixed_expiry_time = $6::time, is_active = $7, updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [
      Number(id),
      payload.name,
      payload.price,
      payload.duration_days,
      payload.expiry_type,
      payload.fixed_expiry_time,
      payload.is_active,
    ],
  )
  return rows[0] ?? null
}

export async function softDeletePlan(id) {
  const pool = requirePool()
  const { rowCount } = await pool.query(
    `UPDATE plans SET deleted_at = now(), updated_at = now(), is_active = false
     WHERE id = $1 AND deleted_at IS NULL`,
    [Number(id)],
  )
  return rowCount > 0
}

/** --- Transactions --- */

export async function insertTransaction(row) {
  const pool = requirePool()
  const raw = row.raw_payload != null ? row.raw_payload : null
  const deviceId =
    row.device_id != null && String(row.device_id).trim()
      ? String(row.device_id).trim()
      : null
  const { rows } = await pool.query(
    `INSERT INTO transactions (
       order_id, external_id, plan_id, phone, amount, currency, status, raw_payload, device_id
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
     RETURNING *`,
    [
      row.order_id,
      row.external_id ?? null,
      row.plan_id,
      row.phone,
      row.amount,
      row.currency ?? 'TZS',
      row.status ?? 'pending',
      raw,
      deviceId,
    ],
  )
  return rows[0]
}

export async function listTransactions(filters = {}) {
  const pool = requirePool()
  const cond = ['1=1']
  const params = []
  let i = 1
  if (filters.status && filters.status !== 'all') {
    cond.push(`t.status = $${i}`)
    params.push(String(filters.status))
    i += 1
  }
  if (filters.from) {
    cond.push(`t.created_at >= $${i}::date`)
    params.push(String(filters.from).slice(0, 10))
    i += 1
  }
  if (filters.to) {
    cond.push(`t.created_at < ($${i}::date + interval '1 day')`)
    params.push(String(filters.to).slice(0, 10))
    i += 1
  }
  const { rows } = await pool.query(
    `SELECT t.*, p.name AS plan_name
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id AND p.deleted_at IS NULL
     WHERE ${cond.join(' AND ')}
     ORDER BY t.created_at DESC`,
    params,
  )
  return rows
}

/** Admin transaction list (raw DB fields for dashboard). */
export async function listTransactionsAdmin(filters = {}) {
  const pool = requirePool()
  const cond = ['1=1']
  const params = []
  let i = 1
  if (filters.status && filters.status !== 'all') {
    cond.push(`t.status = $${i}`)
    params.push(String(filters.status))
    i += 1
  }
  if (filters.from) {
    cond.push(`t.created_at >= $${i}::date`)
    params.push(String(filters.from).slice(0, 10))
    i += 1
  }
  if (filters.to) {
    cond.push(`t.created_at < ($${i}::date + interval '1 day')`)
    params.push(String(filters.to).slice(0, 10))
    i += 1
  }
  const { rows } = await pool.query(
    `SELECT
       t.order_id,
       t.amount,
       t.status,
       t.phone,
       t.device_id,
       t.created_at
     FROM transactions t
     WHERE ${cond.join(' AND ')}
     ORDER BY t.created_at DESC`,
    params,
  )
  return rows
}

export async function deleteTransactionsBulkByOrderIds(orderIds) {
  const ids = Array.isArray(orderIds)
    ? orderIds.map((x) => String(x ?? '').trim()).filter(Boolean)
    : []
  if (ids.length === 0) return { deleted: 0 }
  const pool = requirePool()
  const { rowCount } = await pool.query(`DELETE FROM transactions WHERE order_id = ANY($1::text[])`, [
    ids,
  ])
  return { deleted: Number(rowCount) || 0 }
}

export async function getTransactionByOrderId(orderId) {
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT * FROM transactions WHERE order_id = $1`, [
    String(orderId),
  ])
  return rows[0] ?? null
}

export async function updateTransactionByOrderId(orderId, { status, external_id, raw_payload }) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `UPDATE transactions SET
       status = COALESCE($2, status),
       external_id = COALESCE($3, external_id),
       raw_payload = COALESCE($4::jsonb, raw_payload),
       updated_at = now()
     WHERE order_id = $1
     RETURNING *`,
    [String(orderId), status ?? null, external_id ?? null, raw_payload ?? null],
  )
  return rows[0] ?? null
}

/** --- Subscriptions --- */

/**
 * Expiry at end-of-window: start of calendar day after N days from now, then +18:00 (server TZ / UTC per DB).
 * Same shape as: DATE_TRUNC('day', now() + interval 'N days') + interval '18 hours'
 */
export async function subscriptionExpiresAtEndOfDay(durationDays) {
  const pool = requirePool()
  const days = Math.max(1, Number(durationDays) || 30)
  const { rows } = await pool.query(
    `SELECT (
       date_trunc('day', now() + ($1::int * interval '1 day'))
       + interval '18 hours'
     )::timestamptz AS expires_at`,
    [days],
  )
  const exp = rows[0]?.expires_at
  if (!exp) throw new Error('subscriptionExpiresAtEndOfDay: no result')
  return exp instanceof Date ? exp.toISOString() : String(exp)
}

export async function upsertSubscriptionAfterPayment(phone, planId, expiresAt) {
  const pool = requirePool()
  await pool.query(
    `INSERT INTO subscriptions (phone, plan_id, expires_at, is_active, started_at, updated_at)
     VALUES ($1, $2, $3::timestamptz, true, now(), now())
     ON CONFLICT (phone) DO UPDATE SET
       plan_id = EXCLUDED.plan_id,
       expires_at = EXCLUDED.expires_at,
       is_active = true,
       started_at = now(),
       updated_at = now()`,
    [String(phone).trim(), Number(planId), expiresAt],
  )
}

/** --- Device subscriptions (realtime unlock) --- */

/** Idempotent: duplicate webhooks reuse same order_id → skip writes. */
export async function deviceSubscriptionOrderAlreadyApplied(orderId) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT 1 FROM device_subscriptions WHERE transaction_id = $1 LIMIT 1`,
    [String(orderId).trim()],
  )
  return rows.length > 0
}

export async function getDeviceSubscriptionByDeviceId(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(`SELECT * FROM device_subscriptions WHERE device_id = $1`, [d])
  return rows[0] ?? null
}

/**
 * Server-authoritative access check using PostgreSQL NOW() (never device time).
 */
export async function getDeviceSubscriptionAccessState(deviceId, fingerprint = null) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const fpHash =
    fingerprint && String(fingerprint).trim()
      ? crypto
          .createHash('sha256')
          .update(`${String(process.env.FINGERPRINT_HASH_SALT || 'osmani-fp-v1')}::${String(fingerprint).trim()}`)
          .digest('hex')
      : null
  const { rows } = await pool.query(
    `SELECT
       ds.device_id,
       ds.status,
       ds.expires_at,
       ds.started_at,
       ds.updated_at,
       ds.transaction_id,
       (ds.status = 'active' AND ds.expires_at > now()) AS active_now,
       COALESCE(ad.is_blocked, false) AS blocked_now,
       ad.block_reason
     FROM device_subscriptions ds
     LEFT JOIN admin_devices ad
       ON ad.device_id = ds.device_id
       OR ($2::text IS NOT NULL AND ad.fingerprint_hash = $2::text)
     WHERE ds.device_id = $1
     LIMIT 1`,
    [d, fpHash],
  )
  return rows[0] ?? null
}

/** Touch live presence row so analytics can reflect app-open presence immediately. */
export async function touchLivePresence({ deviceId, country = null, channelId = null }) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const safeCountry = sanitizePresenceText(country, 32)
  const safeChannel = sanitizePresenceText(channelId, 128)
  await pool.query(
    `INSERT INTO live_sessions (device_id, channel_id, country, started_at, updated_at)
     VALUES ($1, $2, $3, now(), now())
     ON CONFLICT (device_id) DO UPDATE SET
       channel_id = COALESCE(EXCLUDED.channel_id, live_sessions.channel_id),
       country = COALESCE(EXCLUDED.country, live_sessions.country),
       updated_at = now()`,
    [d, safeChannel, safeCountry],
  )
  return { deviceId: d, country: safeCountry, channelId: safeChannel }
}

/**
 * Webhook-driven activation. Skips entirely if transaction_id (order_id) already applied.
 * Renewals overwrite the same device_id row with a newer order/expiry only when not a duplicate webhook.
 */
export async function upsertDeviceSubscriptionActive({ deviceId, orderId, expiresAt }) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  const oid = String(orderId ?? '').trim()
  if (!d || !oid) throw new Error('deviceId and orderId required')
  if (await deviceSubscriptionOrderAlreadyApplied(oid)) {
    console.log('[device_subscriptions] idempotent skip — transaction_id already applied:', oid)
    return { skipped: true }
  }
  try {
    await pool.query(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at)
       VALUES ($1, 'active', $2::timestamptz, now(), $3, now())
       ON CONFLICT (device_id) DO UPDATE SET
         status = EXCLUDED.status,
         expires_at = EXCLUDED.expires_at,
         started_at = EXCLUDED.started_at,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now()`,
      [d, expiresAt, oid],
    )
  } catch (e) {
    if (e?.code === '23505') {
      console.log('[device_subscriptions] duplicate transaction_id (race):', oid)
      return { skipped: true }
    }
    throw e
  }
  return { skipped: false }
}

export async function listDeviceUsers() {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT
       ds.device_id,
       ds.status,
       ds.started_at,
       ds.expires_at,
       lt.phone AS phone_number,
       lt.plan_id
     FROM device_subscriptions ds
     LEFT JOIN LATERAL (
       SELECT t.phone, t.plan_id
       FROM transactions t
       WHERE t.device_id = ds.device_id
       ORDER BY t.created_at DESC
       LIMIT 1
     ) lt ON true
     ORDER BY ds.updated_at DESC`,
  )
  return rows
}

export async function updateDeviceSubscriptionByDeviceId(deviceId, { expiresAt, status }) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  const s = status === 'active' ? 'active' : 'pending'
  const { rows } = await pool.query(
    `UPDATE device_subscriptions
     SET expires_at = COALESCE($2::timestamptz, expires_at),
         status = COALESCE($3, status),
         updated_at = now()
     WHERE device_id = $1
     RETURNING *`,
    [d, expiresAt ?? null, s],
  )
  return rows[0] ?? null
}

export async function deleteDeviceUserCascade(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  const delTx = await pool.query(`DELETE FROM transactions WHERE device_id = $1`, [d])
  const delSub = await pool.query(`DELETE FROM device_subscriptions WHERE device_id = $1`, [d])
  return {
    deletedSubscription: Number(delSub.rowCount) || 0,
    deletedTransactions: Number(delTx.rowCount) || 0,
  }
}

/** --- ZenoPay settings (row id = 1) --- */

export async function getZenopayRow() {
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT * FROM zenopay_settings WHERE id = 1`)
  return rows[0] ?? null
}

/**
 * @param {object} d
 * @param {boolean} d.keep_api_key — when true, keep existing api_key
 */
export async function updateZenopayRowFull(d) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `UPDATE zenopay_settings SET
       environment = $1,
       api_endpoint = $2,
       account_id = $3,
       webhook_url = $4,
       api_key = CASE WHEN $5::boolean THEN api_key ELSE $6 END,
       last_test_at = $7::timestamptz,
       last_test_ok = $8,
       last_test_message = $9,
       updated_at = now()
     WHERE id = 1
     RETURNING *`,
    [
      d.environment,
      d.api_endpoint,
      d.account_id,
      d.webhook_url,
      Boolean(d.keep_api_key),
      d.api_key ?? '',
      d.last_test_at ?? null,
      d.last_test_ok ?? null,
      d.last_test_message ?? null,
    ],
  )
  return rows[0]
}
