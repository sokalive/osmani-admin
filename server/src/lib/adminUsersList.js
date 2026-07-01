/**
 * Paginated admin reads for Users / Subscriptions (read-only; no payment/verify logic).
 */
import { getPool } from '../db/pool.js'
import { appendAdminPhoneDeviceSearch } from './phoneSearch.js'
import { normalizePhoneDigits, tzPhoneCanonicalSql } from '../billingStore.js'

const DEFAULT_LIMIT = 25
const MAX_LIMIT = 100
const PENDING_STALE_MINUTES = 30

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

export function clampAdminUsersPagination(page, limit) {
  const p = Math.max(1, Number(page) || 1)
  const l = Math.min(MAX_LIMIT, Math.max(1, Number(limit) || DEFAULT_LIMIT))
  return { page: p, limit: l, offset: (p - 1) * l }
}

export function parseExpiringWithin(raw) {
  const w = String(raw ?? '7d').toLowerCase()
  if (w === '24h' || w === '1d') return { key: '24h', hours: 24 }
  if (w === '3d') return { key: '3d', hours: 72 }
  return { key: '7d', hours: 168 }
}

function providerSql(alias = 'pay') {
  return `COALESCE(NULLIF(${alias}.raw_payload->>'payment_provider',''), 'zenopay')`
}

function failureReasonSql(alias = 't') {
  return `COALESCE(
    NULLIF(${alias}.raw_payload->>'failure_reason',''),
    NULLIF(${alias}.raw_payload->>'error',''),
    NULLIF(${alias}.raw_payload->'zeno'->>'message',''),
    CASE
      WHEN ${alias}.status = 'failed' THEN 'Payment failed'
      WHEN ${alias}.status = 'pending' THEN 'Timed out or abandoned'
      ELSE ${alias}.status
    END
  )`
}

function subscriptionSortSql(sort) {
  const s = String(sort ?? 'newest').toLowerCase()
  switch (s) {
    case 'expiry_soonest':
      return 'ds.expires_at ASC NULLS LAST, ds.device_id ASC'
    case 'amount':
      return 'COALESCE(pay.amount, 0) DESC NULLS LAST, ds.updated_at DESC'
    case 'status':
      return 'ds.status ASC, ds.updated_at DESC'
    default:
      return 'ds.updated_at DESC'
  }
}

function transactionSortSql(sort) {
  const s = String(sort ?? 'newest').toLowerCase()
  switch (s) {
    case 'amount':
      return 't.amount DESC NULLS LAST, t.created_at DESC'
    case 'status':
      return 't.status ASC, t.created_at DESC'
    case 'expiry_soonest':
      return 't.created_at ASC'
    default:
      return 't.created_at DESC'
  }
}

function appendSearch(search, deviceCol, phoneCol, cond, params, i) {
  return appendAdminPhoneDeviceSearch(search, deviceCol, [phoneCol], cond, params, i)
}

function appendSubscriptionSearch(search, cond, params, i) {
  const q = String(search ?? '').trim()
  if (!q) return i
  const esc = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  const parts = [`ds.device_id ILIKE $${i}`]
  params.push(`%${esc}%`)
  let idx = i + 1
  const phoneExprs = [`COALESCE(lt.phone, pay.phone, '')`]
  for (const expr of phoneExprs) {
    parts.push(`${expr} ILIKE $${idx}`)
    params.push(`%${esc}%`)
    idx += 1
  }
  const digits = normalizePhoneDigits(q)
  if (digits && digits.length >= 9) {
    for (const expr of phoneExprs) {
      parts.push(`${tzPhoneCanonicalSql(expr)} = $${idx}`)
      params.push(digits)
      idx += 1
    }
    parts.push(`EXISTS (
      SELECT 1 FROM transactions t_s
      WHERE t_s.device_id = ds.device_id
        AND ${tzPhoneCanonicalSql('t_s.phone::text')} = $${idx}
    )`)
    params.push(digits)
    idx += 1
    parts.push(`EXISTS (
      SELECT 1 FROM device_intelligence_registry ir_s
      WHERE ir_s.device_id = ds.device_id
        AND (
          ${tzPhoneCanonicalSql('ir_s.phone_number')} = $${idx}
          OR ${tzPhoneCanonicalSql('ir_s.account_id')} = $${idx}
        )
    )`)
    params.push(digits)
    idx += 1
  }
  cond.push(`(${parts.join(' OR ')})`)
  return idx
}

const SUBSCRIPTION_FROM = `
  FROM device_subscriptions ds
  LEFT JOIN transactions pay ON pay.order_id = ds.transaction_id
  LEFT JOIN LATERAL (
    SELECT t.phone, t.plan_id, t.amount
    FROM transactions t
    WHERE t.device_id = ds.device_id
    ORDER BY t.created_at DESC
    LIMIT 1
  ) lt ON true
  LEFT JOIN plans p ON p.id = COALESCE(pay.plan_id, lt.plan_id) AND p.deleted_at IS NULL
`

function mapSubscriptionRow(r, nowMs = Date.now()) {
  const exp = r.expires_at instanceof Date ? r.expires_at : new Date(String(r.expires_at))
  const expiresAt = exp instanceof Date && !Number.isNaN(exp.getTime()) ? exp.toISOString() : null
  const startedAtDate = r.started_at instanceof Date ? r.started_at : new Date(String(r.started_at))
  const startedAt =
    startedAtDate instanceof Date && !Number.isNaN(startedAtDate.getTime())
      ? startedAtDate.toISOString()
      : null
  const remainingMs = expiresAt != null ? Math.max(0, new Date(expiresAt).getTime() - nowMs) : 0
  const futureExpiry = expiresAt != null && new Date(expiresAt).getTime() > nowMs
  const active = r.status === 'active' && futureExpiry
  const txnId = String(r.transaction_id ?? '')
  let source = String(r.provider ?? 'zenopay')
  if (txnId.startsWith('manual_grant:')) source = 'manual_grant'
  else if (txnId.startsWith('offer_code:')) source = 'offer_code'
  return {
    device_id: String(r.device_id ?? ''),
    phone_number: String(r.phone_number ?? ''),
    plan_id: r.plan_id != null ? Number(r.plan_id) : null,
    plan_name: r.plan_name != null ? String(r.plan_name) : null,
    amount: r.amount != null ? Number(r.amount) : null,
    status: active ? 'active' : futureExpiry && r.status === 'pending' ? 'revoked' : 'expired',
    started_at: startedAt,
    expires_at: expiresAt,
    remaining: remainingMs,
    provider: source,
    source,
  }
}

function mapFailedPaymentRow(r) {
  const created = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at))
  return {
    order_id: String(r.order_id ?? ''),
    device_id: String(r.device_id ?? ''),
    phone_number: String(r.phone ?? ''),
    plan_id: r.plan_id != null ? Number(r.plan_id) : null,
    plan_name: r.plan_name != null ? String(r.plan_name) : null,
    amount: r.amount != null ? Number(r.amount) : null,
    provider: String(r.provider ?? 'zenopay'),
    failure_reason: String(r.failure_reason ?? ''),
    created_at: created instanceof Date && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
    last_status: String(r.status ?? ''),
    retry_hint:
      String(r.status ?? '') === 'pending'
        ? 'User may still complete USSD — contact if stuck'
        : 'User can retry checkout from the app',
  }
}

async function countQuery(sql, params, client = null) {
  const runner = client ?? requirePool()
  const { rows } = await runner.query(sql, params)
  return Number(rows[0]?.total) || 0
}

/** Consistent COUNT + list snapshot (avoids pagination total drifting mid-request). */
async function withReadSnapshot(fn) {
  const pool = requirePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const result = await fn(client)
    await client.query('COMMIT')
    return result
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

function buildSubscriptionWhere({ search, planId, provider, status, extraWhere, params, startI = 1 }) {
  const cond = [...extraWhere]
  let i = startI
  if (planId != null && planId !== '' && planId !== 'all') {
    cond.push(`COALESCE(pay.plan_id, lt.plan_id) = $${i}`)
    params.push(Number(planId))
    i += 1
  }
  if (provider && provider !== 'all') {
    cond.push(`${providerSql('pay')} = $${i}`)
    params.push(String(provider).toLowerCase())
    i += 1
  }
  const st = String(status ?? 'all').toLowerCase()
  if (st === 'active') {
    cond.push(`ds.status = 'active' AND ds.expires_at > now()`)
  } else if (st === 'expired') {
    cond.push(`(ds.status <> 'active' OR ds.expires_at <= now())`)
  }
  i = appendSubscriptionSearch(search, cond, params, i)
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''
  return { where, nextI: i }
}

async function listSubscriptions({
  extraWhere = [],
  sort,
  page,
  limit,
  search,
  planId,
  provider,
  status,
}) {
  const { page: p, limit: l, offset } = clampAdminUsersPagination(page, limit)
  const params = []
  const { where, nextI } = buildSubscriptionWhere({
    search,
    planId,
    provider,
    status,
    extraWhere,
    params,
  })
  return withReadSnapshot(async (client) => {
    const total = await countQuery(
      `SELECT COUNT(*)::int AS total ${SUBSCRIPTION_FROM} ${where}`,
      params,
      client,
    )
    const listParams = [...params, l, offset]
    const { rows } = await client.query(
      `SELECT
         ds.device_id,
         ds.status,
         ds.started_at,
         ds.expires_at,
         ds.transaction_id,
         COALESCE(lt.phone, pay.phone, '') AS phone_number,
         COALESCE(pay.plan_id, lt.plan_id) AS plan_id,
         p.name AS plan_name,
         COALESCE(pay.amount, lt.amount) AS amount,
         ${providerSql('pay')} AS provider
       ${SUBSCRIPTION_FROM}
       ${where}
       ORDER BY ${subscriptionSortSql(sort)}
       LIMIT $${nextI} OFFSET $${nextI + 1}`,
      listParams,
    )
    const nowMs = Date.now()
    return {
      items: rows.map((r) => mapSubscriptionRow(r, nowMs)),
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.max(1, Math.ceil(total / l)),
      },
    }
  })
}

/** Active paid subscriptions (excludes manual grants, offer codes, admin-blocked). */
export async function listAdminActivePaidUsers(filters = {}) {
  return listSubscriptions({
    ...filters,
    extraWhere: [
      `ds.status = 'active'`,
      `ds.expires_at > now()`,
      `NOT COALESCE(ds.manual_admin_blocked, false)`,
      `ds.transaction_id NOT LIKE 'manual_grant:%'`,
      `ds.transaction_id NOT LIKE 'offer_code:%'`,
    ],
    sort: filters.sort ?? 'expiry_soonest',
  })
}

/** Subscriptions expiring within a window (active only). */
export async function listAdminExpiringSoonUsers(filters = {}) {
  const { hours } = parseExpiringWithin(filters.within)
  const { page: p, limit: l, offset } = clampAdminUsersPagination(filters.page, filters.limit)
  const params = [hours]
  const { where, nextI } = buildSubscriptionWhere({
    search: filters.search,
    planId: filters.planId,
    provider: filters.provider,
    status: 'active',
    extraWhere: [
      `ds.status = 'active'`,
      `ds.expires_at > now()`,
      `ds.expires_at <= now() + ($1::int * interval '1 hour')`,
    ],
    params,
    startI: 2,
  })
  return withReadSnapshot(async (client) => {
    const total = await countQuery(
      `SELECT COUNT(*)::int AS total ${SUBSCRIPTION_FROM} ${where}`,
      params,
      client,
    )
    const listParams = [...params, l, offset]
    const { rows } = await client.query(
      `SELECT
         ds.device_id,
         ds.status,
         ds.started_at,
         ds.expires_at,
         ds.transaction_id,
         COALESCE(lt.phone, pay.phone, '') AS phone_number,
         COALESCE(pay.plan_id, lt.plan_id) AS plan_id,
         p.name AS plan_name,
         COALESCE(pay.amount, lt.amount) AS amount,
         ${providerSql('pay')} AS provider
       ${SUBSCRIPTION_FROM}
       ${where}
       ORDER BY ${subscriptionSortSql(filters.sort ?? 'expiry_soonest')}
       LIMIT $${nextI} OFFSET $${nextI + 1}`,
      listParams,
    )
    const nowMs = Date.now()
    return {
      items: rows.map((r) => mapSubscriptionRow(r, nowMs)),
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.max(1, Math.ceil(total / l)),
      },
    }
  })
}

/** All device subscriptions (paginated). */
export async function listAdminAllSubscriptions(filters = {}) {
  return listSubscriptions({
    ...filters,
    sort: filters.sort ?? 'newest',
  })
}

/** Failed / abandoned payment attempts. */
export async function listAdminFailedPayments(filters = {}) {
  const { page: p, limit: l, offset } = clampAdminUsersPagination(filters.page, filters.limit)
  const cond = [
    `t.plan_id IS NOT NULL`,
    `(
      t.status = 'failed'
      OR (
        t.status = 'pending'
        AND t.created_at < now() - ($1::int * interval '1 minute')
      )
    )`,
  ]
  const params = [PENDING_STALE_MINUTES]
  let i = 2
  if (filters.planId != null && filters.planId !== '' && filters.planId !== 'all') {
    cond.push(`t.plan_id = $${i}`)
    params.push(Number(filters.planId))
    i += 1
  }
  if (filters.provider && filters.provider !== 'all') {
    cond.push(`${providerSql('t')} = $${i}`)
    params.push(String(filters.provider).toLowerCase())
    i += 1
  }
  const st = String(filters.status ?? 'all').toLowerCase()
  if (st === 'failed') {
    cond.push(`t.status = 'failed'`)
  } else if (st === 'pending') {
    cond.push(`t.status = 'pending'`)
  }
  i = appendAdminPhoneDeviceSearch(
    filters.search,
    `COALESCE(t.device_id, '')`,
    [
      `COALESCE(t.phone, '')`,
      `COALESCE(t.raw_payload->>'phone','')`,
      `COALESCE(t.raw_payload->>'phoneNorm','')`,
    ],
    cond,
    params,
    i,
  )
  const where = `WHERE ${cond.join(' AND ')}`
  return withReadSnapshot(async (client) => {
    const total = await countQuery(
      `SELECT COUNT(*)::int AS total
       FROM transactions t
       ${where}`,
      params,
      client,
    )
    const listParams = [...params, l, offset]
    const { rows } = await client.query(
      `SELECT
         t.order_id,
         t.device_id,
         t.phone,
         t.plan_id,
         p.name AS plan_name,
         t.amount,
         t.status,
         t.created_at,
         ${providerSql('t')} AS provider,
         ${failureReasonSql('t')} AS failure_reason
       FROM transactions t
       LEFT JOIN plans p ON p.id = t.plan_id AND p.deleted_at IS NULL
       ${where}
       ORDER BY ${transactionSortSql(filters.sort ?? 'newest')}
       LIMIT $${i} OFFSET $${i + 1}`,
      listParams,
    )
    return {
      items: rows.map(mapFailedPaymentRow),
      pagination: {
        page: p,
        limit: l,
        total,
        totalPages: Math.max(1, Math.ceil(total / l)),
      },
    }
  })
}

/** Tab badge counts (cheap aggregate queries). */
export async function getAdminUsersSummary() {
  const pool = requirePool()
  const staleMin = PENDING_STALE_MINUTES
  const { rows } = await pool.query(
    `SELECT
       (
         SELECT COUNT(*)::int
         FROM device_subscriptions ds
         WHERE ds.status = 'active'
           AND ds.expires_at > now()
           AND NOT COALESCE(ds.manual_admin_blocked, false)
           AND ds.transaction_id NOT LIKE 'manual_grant:%'
           AND ds.transaction_id NOT LIKE 'offer_code:%'
       ) AS active_paid,
       (
         SELECT COUNT(*)::int
         FROM device_subscriptions ds
         WHERE ds.status = 'active'
           AND ds.expires_at > now()
           AND ds.expires_at <= now() + interval '24 hours'
       ) AS expiring_24h,
       (
         SELECT COUNT(*)::int
         FROM device_subscriptions ds
         WHERE ds.status = 'active'
           AND ds.expires_at > now()
           AND ds.expires_at <= now() + interval '3 days'
       ) AS expiring_3d,
       (
         SELECT COUNT(*)::int
         FROM device_subscriptions ds
         WHERE ds.status = 'active'
           AND ds.expires_at > now()
           AND ds.expires_at <= now() + interval '7 days'
       ) AS expiring_7d,
       (
         SELECT COUNT(*)::int
         FROM transactions t
         WHERE t.plan_id IS NOT NULL
           AND (
             t.status = 'failed'
             OR (t.status = 'pending' AND t.created_at < now() - ($1::int * interval '1 minute'))
           )
       ) AS failed_payments,
       (SELECT COUNT(*)::int FROM device_subscriptions) AS all_subscriptions`,
    [staleMin],
  )
  const r = rows[0] ?? {}
  return {
    active_paid: Number(r.active_paid) || 0,
    expiring_24h: Number(r.expiring_24h) || 0,
    expiring_3d: Number(r.expiring_3d) || 0,
    expiring_7d: Number(r.expiring_7d) || 0,
    failed_payments: Number(r.failed_payments) || 0,
    all_subscriptions: Number(r.all_subscriptions) || 0,
  }
}
