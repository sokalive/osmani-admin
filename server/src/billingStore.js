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
  const { rows } = await pool.query(
    `INSERT INTO transactions (
       order_id, external_id, plan_id, phone, amount, currency, status, raw_payload
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
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
