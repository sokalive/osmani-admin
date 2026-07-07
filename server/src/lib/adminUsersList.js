/**
 * Paginated admin reads for Users / Subscriptions (read-only; no payment/verify logic).
 */
import { getPool } from '../db/pool.js'
import { appendAdminPhoneDeviceSearch } from './phoneSearch.js'
import { normalizePhoneDigits, tzPhoneCanonicalSql } from '../billingStore.js'
import { parseMovedTransactionId } from './paymentOrderRecoveryClassifier.js'

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
  return `NULLIF(${alias}.raw_payload->>'payment_provider','')`
}

/** Subscription row source for admin lists (payment, grant, transfer, recovery). */
function subscriptionSourceSql(dsAlias = 'ds', payAlias = 'pay') {
  return `CASE
    WHEN ${dsAlias}.transaction_id LIKE 'manual_grant:%' THEN 'manual_grant'
    WHEN ${dsAlias}.transaction_id LIKE 'offer_code:%' THEN 'offer_code'
    WHEN ${dsAlias}.transaction_id LIKE 'transfer:%' THEN 'transfer'
    WHEN ${dsAlias}.transaction_id LIKE 'recovery:%' THEN 'recovery'
    WHEN ${dsAlias}.transaction_id LIKE 'moved:%' THEN COALESCE(NULLIF(moved_pay.moved_provider, ''), 'historical')
    ELSE COALESCE(${providerSql(payAlias)}, NULLIF(lt.provider, ''), 'unknown')
  END`
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
    case 'started_newest':
      return 'ds.started_at DESC NULLS LAST, ds.device_id ASC'
    case 'amount':
      return 'COALESCE(pay.amount, 0) DESC NULLS LAST, ds.updated_at DESC, ds.device_id ASC'
    case 'status':
      return 'ds.status ASC, ds.updated_at DESC, ds.device_id ASC'
    default:
      return 'ds.started_at DESC NULLS LAST, ds.device_id ASC'
  }
}

function transactionSortSql(sort) {
  const s = String(sort ?? 'newest').toLowerCase()
  switch (s) {
    case 'amount':
      return 't.amount DESC NULLS LAST, t.created_at DESC, t.order_id ASC'
    case 'status':
      return 't.status ASC, t.created_at DESC, t.order_id ASC'
    case 'expiry_soonest':
      return 't.created_at ASC, t.order_id ASC'
    default:
      return 't.created_at DESC, t.order_id ASC'
  }
}

function appendSearch(search, deviceCol, phoneCol, cond, params, i) {
  return appendAdminPhoneDeviceSearch(search, deviceCol, [phoneCol], cond, params, i)
}

function appendSubscriptionSearch(search, cond, params, i) {
  const q = String(search ?? '').trim()
  if (!q) return i
  if (/^[a-f0-9]{64}$/i.test(q)) {
    cond.push(`ds.device_id = $${i}`)
    params.push(q.toLowerCase())
    return i + 1
  }
  const digits = normalizePhoneDigits(q)
  const phoneExprs = [`COALESCE(lt.phone, pay.phone, '')`]
  if (digits && digits.length >= 9) {
    const phoneParts = []
    let idx = i
    for (const expr of phoneExprs) {
      phoneParts.push(`${tzPhoneCanonicalSql(expr)} = $${idx}`)
      params.push(digits)
      idx += 1
    }
    phoneParts.push(`EXISTS (
      SELECT 1 FROM transactions t_s
      WHERE t_s.device_id = ds.device_id
        AND ${tzPhoneCanonicalSql('t_s.phone::text')} = $${idx}
    )`)
    params.push(digits)
    idx += 1
    phoneParts.push(`EXISTS (
      SELECT 1 FROM device_phone_registry dpr_eq
      WHERE dpr_eq.device_id::text = ds.device_id
        AND dpr_eq.phone_number_normalized = $${idx}
    )`)
    params.push(digits)
    idx += 1
    cond.push(`(${phoneParts.join(' OR ')})`)
    return idx
  }
  const esc = q.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
  const parts = [`ds.device_id ILIKE $${i}`]
  params.push(`%${esc}%`)
  let idx = i + 1
  parts.push(`ds.transaction_id ILIKE $${idx}`)
  params.push(`%${esc}%`)
  idx += 1
  parts.push(`pay.order_id ILIKE $${idx}`)
  params.push(`%${esc}%`)
  idx += 1
  parts.push(`pay.external_id ILIKE $${idx}`)
  params.push(`%${esc}%`)
  idx += 1
  parts.push(`EXISTS (
    SELECT 1 FROM device_intelligence_registry ir_q
    WHERE ir_q.device_id = ds.device_id
      AND (ir_q.user_id ILIKE $${idx} OR ir_q.account_id ILIKE $${idx})
  )`)
  params.push(`%${esc}%`)
  idx += 1
  for (const expr of phoneExprs) {
    parts.push(`${expr} ILIKE $${idx}`)
    params.push(`%${esc}%`)
    idx += 1
  }
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
      SELECT 1 FROM transactions t_s
      WHERE t_s.device_id = ds.device_id
        AND (
          ${tzPhoneCanonicalSql("t_s.raw_payload->>'phoneNorm'")} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->>'phone'")} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->'sonicpesa'->'data'->>'msisdn'")} = $${idx}
          OR ${tzPhoneCanonicalSql("t_s.raw_payload->'order_status_poll'->'data'->>'msisdn'")} = $${idx}
        )
    )`)
    params.push(digits)
    idx += 1
    parts.push(`EXISTS (
      SELECT 1 FROM transactions t_s
      WHERE t_s.device_id = ds.device_id
        AND t_s.order_id ILIKE $${idx}
    )`)
    params.push(`%${esc}%`)
    idx += 1
    parts.push(`EXISTS (
      SELECT 1 FROM device_phone_registry dpr_s
      WHERE dpr_s.device_id::text = ds.device_id::text
        AND dpr_s.phone_number_normalized = $${idx}
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

/** Safe manual-grant join: CASE short-circuits so payment refs (osm_*, force:*, etc.) are never cast to bigint. */
const MANUAL_GRANT_JOIN_SQL = `LEFT JOIN manual_subscription_grants mg ON (
    mg.deleted_at IS NULL
    AND mg.id = CASE
      WHEN ds.transaction_id ~ '^manual_grant:[0-9]+$'
      THEN (substring(ds.transaction_id from 14))::bigint
    END
  )`

const SUBSCRIPTION_FROM = `
  FROM device_subscriptions ds
  LEFT JOIN transactions pay ON pay.order_id = ds.transaction_id
  ${MANUAL_GRANT_JOIN_SQL}
  LEFT JOIN LATERAL (
    SELECT t.phone, t.plan_id, t.amount,
      COALESCE(NULLIF(t.raw_payload->>'payment_provider', ''), NULLIF(t.provider_label, '')) AS provider
    FROM transactions t
    WHERE t.device_id = ds.device_id
    ORDER BY t.created_at DESC
    LIMIT 1
  ) lt ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(
      NULLIF(t.raw_payload->>'payment_provider', ''),
      NULLIF(t.provider_label, '')
    ) AS moved_provider
    FROM transactions t
    WHERE ds.transaction_id LIKE 'moved:%'
      AND t.order_id = regexp_replace(ds.transaction_id, '^moved:[^:]+:(.+)$', '\\1')
    LIMIT 1
  ) moved_pay ON ds.transaction_id LIKE 'moved:%'
  LEFT JOIN plans p ON p.id = COALESCE(pay.plan_id, lt.plan_id, mg.plan_id) AND p.deleted_at IS NULL
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
  const revoked =
    String(r.status ?? '').toLowerCase() === 'revoked' || Boolean(r.admin_revoked_at)
  const active = r.status === 'active' && futureExpiry && !revoked
  const txnId = String(r.transaction_id ?? '')
  const moved = parseMovedTransactionId(txnId)
  const isMovedSource = moved.isMoved === true
  let source = String(r.provider ?? '').trim().toLowerCase()
  if (txnId.startsWith('manual_grant:')) source = 'manual_grant'
  else if (txnId.startsWith('offer_code:')) source = 'offer_code'
  else if (txnId.startsWith('transfer:')) source = 'transfer'
  else if (txnId.startsWith('recovery:')) source = 'recovery'
  else if (isMovedSource && (!source || source === 'unknown')) source = 'historical'
  else if (!source) source = 'unknown'
  const status = active
    ? 'active'
    : revoked
      ? 'revoked'
      : isMovedSource && futureExpiry
        ? 'historical'
        : futureExpiry && r.status === 'pending'
          ? 'pending'
          : 'expired'
  return {
    device_id: String(r.device_id ?? ''),
    phone_number: String(r.phone_number ?? ''),
    plan_id: r.plan_id != null ? Number(r.plan_id) : null,
    plan_name: r.plan_name != null ? String(r.plan_name) : null,
    amount: r.amount != null ? Number(r.amount) : null,
    status,
    started_at: startedAt,
    expires_at: expiresAt,
    remaining: remainingMs,
    provider: source,
    source,
    transaction_id: txnId,
  }
}

/** Evidence-based subscription projection for admin operational UI (exported for lookup). */
export const mapOperationalSubscriptionRow = mapSubscriptionRow

/** Single-device operational subscription row (same joins as list). */
export async function getOperationalSubscriptionByDeviceId(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT
       ds.device_id,
       ds.status,
       ds.started_at,
       ds.expires_at,
       ds.transaction_id,
       ds.admin_revoked_at,
       COALESCE(lt.phone, pay.phone, '') AS phone_number,
       COALESCE(pay.plan_id, lt.plan_id, mg.plan_id) AS plan_id,
       p.name AS plan_name,
       COALESCE(pay.amount, lt.amount, p.price) AS amount,
       ${subscriptionSourceSql('ds', 'pay')} AS provider
     ${SUBSCRIPTION_FROM}
     WHERE ds.device_id = $1
     LIMIT 1`,
    [d],
  )
  if (!rows[0]) return null
  return mapSubscriptionRow(rows[0])
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
    provider: String(r.provider ?? 'unknown'),
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
    const pid = Number(planId)
    if (Number.isFinite(pid) && pid > 0) {
      cond.push(`COALESCE(pay.plan_id, lt.plan_id, mg.plan_id) = $${i}`)
      params.push(pid)
      i += 1
    }
  }
  if (provider && provider !== 'all') {
    cond.push(`${subscriptionSourceSql('ds', 'pay')} = $${i}`)
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
         ds.admin_revoked_at,
         COALESCE(lt.phone, pay.phone, '') AS phone_number,
         COALESCE(pay.plan_id, lt.plan_id, mg.plan_id) AS plan_id,
         p.name AS plan_name,
         COALESCE(pay.amount, lt.amount, p.price) AS amount,
         ${subscriptionSourceSql('ds', 'pay')} AS provider
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
         ds.admin_revoked_at,
         COALESCE(lt.phone, pay.phone, '') AS phone_number,
         COALESCE(pay.plan_id, lt.plan_id, mg.plan_id) AS plan_id,
         p.name AS plan_name,
         COALESCE(pay.amount, lt.amount, p.price) AS amount,
         ${subscriptionSourceSql('ds', 'pay')} AS provider
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
    const pid = Number(filters.planId)
    if (Number.isFinite(pid) && pid > 0) {
      cond.push(`t.plan_id = $${i}`)
      params.push(pid)
      i += 1
    }
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
  const txnSearch = String(filters.search ?? '').trim()
  if (txnSearch) {
    const esc = txnSearch.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
    cond.push(`(
      t.order_id ILIKE $${i}
      OR t.external_id ILIKE $${i + 1}
      OR t.device_id ILIKE $${i + 2}
      OR EXISTS (
        SELECT 1 FROM device_intelligence_registry ir_f
        WHERE ir_f.device_id = t.device_id
          AND (ir_f.user_id ILIKE $${i + 3} OR ir_f.account_id ILIKE $${i + 3})
      )
    )`)
    params.push(`%${esc}%`, `%${esc}%`, `%${esc}%`, `%${esc}%`)
    i += 4
  }
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
