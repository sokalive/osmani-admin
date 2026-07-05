import crypto from 'node:crypto'
import { computeStackedExpiryIso } from './lib/subscriptionStacking.js'
import { tryRecordAppInstall } from './lib/installAnalytics.js'
import { ensureBootstrapAdminPanelUser } from './adminAuthStore.js'
import { ensureBillingTables } from './db/billingTables.js'
import { getPool } from './db/pool.js'
import { normalizeLocationPayload } from './lib/analyticsLocation.js'
import { upsertLiveSession } from './lib/liveSessionStore.js'
import { invalidateSubscriptionAccessCache } from './lib/subscriptionAccessCache.js'
import { notifySubscriptionActivated } from './lib/subscriptionActivationNotify.js'
import { publishManualGrantActivationRealtime } from './lib/manualGrantRealtime.js'

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
  await ensureBootstrapAdminPanelUser().catch((err) => {
    console.error('[admin-panel-bootstrap]', err?.message || err)
  })
  try {
    const { syncAllIntelligenceBlocksToPlayback } = await import('./lib/deviceIntelligenceStore.js')
    const sync = await syncAllIntelligenceBlocksToPlayback()
    if (sync.synced > 0) {
      console.log('[users-intelligence] startup synced blocks to playback:', sync.synced)
    }
  } catch (err) {
    console.error('[users-intelligence] startup block sync failed:', err?.message || err)
  }
}

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

/** SHA-256 hardware fingerprint hash (matches deviceSecurity + trial watch). */
export function hashDeviceFingerprint(fingerprint) {
  const raw = String(fingerprint ?? '').trim()
  if (!raw) return null
  return crypto
    .createHash('sha256')
    .update(`${String(process.env.FINGERPRINT_HASH_SALT || 'osmani-fp-v1')}::${raw}`)
    .digest('hex')
}

/** Manual Subscription admin PIN (scrypt; env pin remains legacy until DB hash is set). */
export const MANUAL_SUBSCRIPTION_PIN_MIN_LENGTH = 6

const MANUAL_PIN_SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }

function hashManualPinScrypt(plain) {
  const salt = crypto.randomBytes(16)
  const hash = crypto.scryptSync(String(plain), salt, 64, MANUAL_PIN_SCRYPT_PARAMS)
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`
}

function verifyManualPinHashScrypt(plain, stored) {
  const parts = String(stored ?? '').split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  try {
    const salt = Buffer.from(parts[1], 'hex')
    const expected = Buffer.from(parts[2], 'hex')
    const hash = crypto.scryptSync(String(plain), salt, 64, MANUAL_PIN_SCRYPT_PARAMS)
    return hash.length === expected.length && crypto.timingSafeEqual(hash, expected)
  } catch {
    return false
  }
}

/** True if env PIN (legacy) or DB hash row is non-empty. */
export async function isManualSubscriptionPinConfigured() {
  const envPin = String(process.env.MANUAL_SUBSCRIPTION_ADMIN_PIN ?? '').trim()
  if (envPin.length >= 4) return true
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT pin_hash FROM manual_subscription_admin_pin WHERE id = 1`)
  const h = rows[0]?.pin_hash
  return typeof h === 'string' && h.trim().length > 0
}

/** Verify grant PIN: prefer DB scrypt hash; else legacy env MANUAL_SUBSCRIPTION_ADMIN_PIN. */
export async function verifyManualSubscriptionGrantPin(submitted) {
  const pin = String(submitted ?? '')
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT pin_hash FROM manual_subscription_admin_pin WHERE id = 1`)
  const stored = rows[0]?.pin_hash
  if (typeof stored === 'string' && stored.startsWith('scrypt$')) {
    return verifyManualPinHashScrypt(pin, stored)
  }
  const envPin = process.env.MANUAL_SUBSCRIPTION_ADMIN_PIN
  if (envPin != null && String(envPin).trim().length >= 4) {
    const a = crypto.createHash('sha256').update(pin, 'utf8').digest()
    const b = crypto.createHash('sha256').update(String(envPin), 'utf8').digest()
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  return false
}

/** First-time only; refuses if already configured (env or DB). Stores scrypt hash only. */
export async function setupManualSubscriptionPinFirstTime(plain) {
  if (await isManualSubscriptionPinConfigured()) {
    const err = new Error('PIN already configured')
    err.code = 'PIN_ALREADY_CONFIGURED'
    throw err
  }
  const p = String(plain ?? '')
  if (p.length < MANUAL_SUBSCRIPTION_PIN_MIN_LENGTH) {
    const err = new Error(`PIN must be at least ${MANUAL_SUBSCRIPTION_PIN_MIN_LENGTH} characters`)
    err.code = 'PIN_TOO_SHORT'
    throw err
  }
  const hashed = hashManualPinScrypt(p)
  const pool = requirePool()
  await pool.query(
    `INSERT INTO manual_subscription_admin_pin (id, pin_hash, updated_at)
     VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET pin_hash = EXCLUDED.pin_hash, updated_at = now()`,
    [hashed],
  )
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
      SELECT t.plan_id, COUNT(*)::int AS cnt
      FROM device_subscriptions ds
      INNER JOIN transactions t ON t.order_id = ds.transaction_id
      WHERE ds.status = 'active'
        AND ds.expires_at > now()
        AND t.plan_id IS NOT NULL
      GROUP BY t.plan_id
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
  void import('./lib/adminPaymentRecovery.js')
    .then((m) => m.enrichTransactionLedgerFields(row.order_id))
    .catch(() => {})
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

/** Lookup by provider order id (SonicPesa `sp_…` stored in external_id). */
export async function getTransactionByExternalId(externalId) {
  const id = String(externalId ?? '').trim()
  if (!id) return null
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT * FROM transactions WHERE external_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [id],
  )
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

/**
 * Canonical Tanzania phone digits for comparisons.
 *  - 0678089174  -> 255678089174
 *  - 255678089174 -> 255678089174
 *  - +255678089174 -> 255678089174
 */
export function normalizePhoneDigits(phone) {
  const digits = String(phone ?? '').replace(/[^0-9]/g, '')
  if (!digits) return ''
  if (/^0\d{9}$/.test(digits)) return `255${digits.slice(1)}`
  if (/^[67]\d{8}$/.test(digits)) return `255${digits}`
  if (/^255\d{9}$/.test(digits)) return digits
  return digits
}

export function tzPhoneCanonicalSql(expr) {
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

export async function getLatestCompletedTransactionByNormalizedPhone(phoneInput) {
  const digits = normalizePhoneDigits(phoneInput)
  if (!digits || digits.length < 10) return null
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT *
     FROM transactions t
     WHERE t.status = 'completed'
       AND ${tzPhoneCanonicalSql('t.phone::text')} = $1
     ORDER BY t.created_at DESC
     LIMIT 1`,
    [digits],
  )
  return rows[0] ?? null
}

/**
 * Resolve the device_id that currently holds an active subscription tied to this payment phone.
 * When proofDeviceId is set, require that device to also have a txn with the same phone (migration safety).
 */
export async function findActiveDeviceIdForPaymentPhone(phoneInput, opts = {}) {
  const digits = normalizePhoneDigits(phoneInput)
  if (!digits || digits.length < 10) return null
  const proofDeviceId = String(opts.proofDeviceId ?? '').trim()
  const pool = requirePool()
  const phoneDevicesCte = `
    phone_txn_devices AS (
      SELECT DISTINCT trim(t.device_id::text) AS device_id
      FROM transactions t
      WHERE t.status = 'completed'
        AND trim(coalesce(t.device_id::text, '')) <> ''
        AND trim(coalesce(t.phone::text, '')) <> ''
        AND ${tzPhoneCanonicalSql('t.phone::text')} = $1
      UNION
      SELECT DISTINCT trim(ir.device_id::text) AS device_id
      FROM device_intelligence_registry ir
      WHERE trim(coalesce(ir.device_id::text, '')) <> ''
        AND (
          ${tzPhoneCanonicalSql('ir.phone_number')} = $1
          OR ${tzPhoneCanonicalSql('ir.account_id')} = $1
        )
      UNION
      SELECT DISTINCT trim(dpr.device_id::text) AS device_id
      FROM device_phone_registry dpr
      WHERE trim(coalesce(dpr.device_id::text, '')) <> ''
        AND trim(coalesce(dpr.phone_number_normalized, '')) <> ''
        AND dpr.phone_number_normalized = $1
    ),
    linked_devices AS (
      SELECT device_id FROM phone_txn_devices
      UNION
      SELECT DISTINCT ai_new.device_id::text AS device_id
      FROM app_installs ai_new
      INNER JOIN app_installs ai_src
        ON ai_src.install_instance_id = ai_new.install_instance_id
       AND trim(ai_src.install_instance_id) <> ''
       AND ai_src.device_id <> ai_new.device_id
      INNER JOIN phone_txn_devices p ON p.device_id = ai_src.device_id::text
      UNION
      SELECT DISTINCT ai_new.device_id::text AS device_id
      FROM app_installs ai_new
      INNER JOIN app_installs ai_src
        ON ai_src.install_instance_id = ai_new.install_instance_id
       AND trim(ai_src.install_instance_id) <> ''
       AND ai_src.device_id <> ai_new.device_id
      INNER JOIN phone_txn_devices p ON p.device_id = ai_new.device_id::text
    )`
  const proofClause = ''
  if (proofDeviceId) {
    const { rows: linkRows } = await pool.query(
      `WITH ${phoneDevicesCte}
       SELECT 1 FROM linked_devices WHERE device_id = $2 LIMIT 1`,
      [digits, proofDeviceId],
    )
    if (!linkRows[0]) return null
  }
  const params = [digits]

  const { rows } = await pool.query(
    `WITH ${phoneDevicesCte}
     SELECT ds.device_id::text AS device_id
     FROM device_subscriptions ds
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND ds.device_id IN (SELECT device_id FROM linked_devices)
       ${proofClause}
     ORDER BY ds.expires_at DESC
     LIMIT 1`,
    params,
  )
  if (rows[0]?.device_id) return String(rows[0].device_id)

  const txn = await getLatestCompletedTransactionByNormalizedPhone(phoneInput)
  if (!txn) return null
  const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  const dev = String(txn.device_id ?? '').trim() || String(raw.device_id ?? '').trim()
  if (!dev) return null
  if (proofDeviceId && proofDeviceId !== dev) {
    const { rows: proofRows } = await pool.query(
      `WITH ${phoneDevicesCte}
       SELECT 1 FROM linked_devices WHERE device_id = $2 LIMIT 1`,
      [digits, proofDeviceId],
    )
    if (!proofRows[0]) return null
  }
  const { rows: dr } = await pool.query(
    `WITH ${phoneDevicesCte}
     SELECT ds.device_id::text AS device_id
     FROM device_subscriptions ds
     WHERE ds.device_id = $2
       AND ds.status = 'active'
       AND ds.expires_at > now()
       AND ds.device_id IN (SELECT device_id FROM linked_devices)
     LIMIT 1`,
    [digits, dev],
  )
  return dr[0]?.device_id ? String(dr[0].device_id) : null
}

/** True when device_id is tied to a completed payment phone (txn, registry, or install_instance sibling). */
export async function isDeviceLinkedToPaymentPhone(deviceId, phoneInput) {
  const digits = normalizePhoneDigits(phoneInput)
  const d = String(deviceId ?? '').trim()
  if (!digits || digits.length < 10 || !d) return false
  const pool = requirePool()
  const phoneDevicesCte = `
    phone_txn_devices AS (
      SELECT DISTINCT trim(t.device_id::text) AS device_id
      FROM transactions t
      WHERE t.status = 'completed'
        AND trim(coalesce(t.device_id::text, '')) <> ''
        AND trim(coalesce(t.phone::text, '')) <> ''
        AND ${tzPhoneCanonicalSql('t.phone::text')} = $1
      UNION
      SELECT DISTINCT trim(ir.device_id::text) AS device_id
      FROM device_intelligence_registry ir
      WHERE trim(coalesce(ir.device_id::text, '')) <> ''
        AND (
          ${tzPhoneCanonicalSql('ir.phone_number')} = $1
          OR ${tzPhoneCanonicalSql('ir.account_id')} = $1
        )
      UNION
      SELECT DISTINCT trim(dpr.device_id::text) AS device_id
      FROM device_phone_registry dpr
      WHERE trim(coalesce(dpr.device_id::text, '')) <> ''
        AND trim(coalesce(dpr.phone_number_normalized, '')) <> ''
        AND dpr.phone_number_normalized = $1
    ),
    linked_devices AS (
      SELECT device_id FROM phone_txn_devices
      UNION
      SELECT DISTINCT ai_new.device_id::text AS device_id
      FROM app_installs ai_new
      INNER JOIN app_installs ai_src
        ON ai_src.install_instance_id = ai_new.install_instance_id
       AND trim(ai_src.install_instance_id) <> ''
       AND ai_src.device_id <> ai_new.device_id
      INNER JOIN phone_txn_devices p ON p.device_id = ai_src.device_id::text
      UNION
      SELECT DISTINCT ai_new.device_id::text AS device_id
      FROM app_installs ai_new
      INNER JOIN app_installs ai_src
        ON ai_src.install_instance_id = ai_new.install_instance_id
       AND trim(ai_src.install_instance_id) <> ''
       AND ai_src.device_id <> ai_new.device_id
      INNER JOIN phone_txn_devices p ON p.device_id = ai_new.device_id::text
    )`
  const { rows } = await pool.query(
    `WITH ${phoneDevicesCte}
     SELECT 1 FROM linked_devices WHERE device_id = $2 LIMIT 1`,
    [digits, d],
  )
  return Boolean(rows[0])
}

/** --- Subscriptions --- */

/**
 * Voucher-style expiry: expires_at = anchor + (duration_days × 24 hours), using PostgreSQL `now()`.
 * Anchor = current expires_at while still active (stack renewals), else `now()` (new purchase / lapsed).
 */
function dbQuery(client) {
  return client && typeof client.query === 'function'
    ? client.query.bind(client)
    : requirePool().query.bind(requirePool())
}

export async function computeDeviceSubscriptionExpiryAfterPurchase(deviceId, durationDays, client = null) {
  const q = dbQuery(client)
  const d = String(deviceId ?? '').trim()
  if (!d) throw new Error('computeDeviceSubscriptionExpiryAfterPurchase: deviceId required')
  const days = Math.max(1, Number(durationDays) || 30)
  const { rows } = await q(
    `SELECT expires_at FROM device_subscriptions WHERE device_id = $1 LIMIT 1`,
    [d],
  )
  const prev = rows[0]?.expires_at ?? null
  const stack = computeStackedExpiryIso(prev, days)
  return {
    expiresAt: stack.expiresAt,
    previousExpiresAt: stack.previousExpiresAt,
    anchorAt: stack.anchorAt,
    purchasedDurationDays: stack.purchasedDurationDays,
    stacked: stack.stacked,
  }
}

/**
 * Exact-duration expiry from **now** (no stacking — legacy helper).
 * Prefer {@link computeDeviceSubscriptionExpiryAfterPurchase} for device activation.
 */
export async function subscriptionExpiresAtEndOfDay(durationDays) {
  const pool = requirePool()
  const days = Math.max(1, Number(durationDays) || 30)
  const { rows } = await pool.query(
    `SELECT (now() + ($1::bigint * interval '24 hours'))::timestamptz AS expires_at`,
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
export async function deviceSubscriptionOrderAlreadyApplied(orderId, client = null) {
  const q = dbQuery(client)
  const oid = String(orderId).trim()
  const { rows } = await q(
    `SELECT status, expires_at FROM device_subscriptions WHERE transaction_id = $1 LIMIT 1`,
    [oid],
  )
  const r = rows[0]
  if (!r) return false
  if (String(r.status ?? '') !== 'active') return false
  const exp = r.expires_at instanceof Date ? r.expires_at : new Date(String(r.expires_at ?? ''))
  return Number.isFinite(exp.getTime()) && exp.getTime() > Date.now()
}

export async function getDeviceSubscriptionByDeviceId(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(`SELECT * FROM device_subscriptions WHERE device_id = $1`, [d])
  return rows[0] ?? null
}

/**
 * Hot-path subscription lookup (verify / premium gate) — no admin/intelligence joins.
 */
export async function getDeviceSubscriptionAccessStateFast(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT
       ds.device_id,
       ds.status,
       ds.expires_at,
       ds.started_at,
       ds.updated_at,
       ds.transaction_id,
       ds.admin_revoked_at,
       (ds.status = 'active' AND ds.expires_at > now()) AS active_now,
       COALESCE(ds.manual_admin_blocked, false) AS blocked_now,
       CASE WHEN COALESCE(ds.manual_admin_blocked, false) THEN 'admin_blocked' ELSE NULL END AS block_reason,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ds.expires_at - now())))::bigint)
         ELSE 0::bigint
       END AS remaining_seconds,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 3600.0)::int)
         ELSE 0
       END AS remaining_hours,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 86400.0)::int)
         ELSE 0
       END AS remaining_days,
       (
         ds.status = 'active'
         AND ds.expires_at IS NOT NULL
         AND ds.expires_at > now()
         AND ds.expires_at <= now() + interval '48 hours'
       ) AS near_expiry
     FROM device_subscriptions ds
     WHERE ds.device_id = $1
     LIMIT 1`,
    [d],
  )
  return rows[0] ?? null
}

/**
 * Single round-trip for verify premium gate: subscription row + latest recent pending txn.
 * Always returns one logical row (subscription fields may be null).
 */
export async function getVerifyAccessSnapshot(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return { row: null, pendingTxn: null }
  const mins = verifyPendingMaxAgeMinutes()
  const { rows } = await pool.query(
    `SELECT
       ds.device_id,
       ds.status,
       ds.expires_at,
       ds.started_at,
       ds.updated_at,
       ds.transaction_id,
       ds.admin_revoked_at,
       (ds.status = 'active' AND ds.expires_at > now()) AS active_now,
       COALESCE(ds.manual_admin_blocked, false) AS blocked_now,
       CASE WHEN COALESCE(ds.manual_admin_blocked, false) THEN 'admin_blocked' ELSE NULL END AS block_reason,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ds.expires_at - now())))::bigint)
         ELSE 0::bigint
       END AS remaining_seconds,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 3600.0)::int)
         ELSE 0
       END AS remaining_hours,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 86400.0)::int)
         ELSE 0
       END AS remaining_days,
       (
         ds.status = 'active'
         AND ds.expires_at IS NOT NULL
         AND ds.expires_at > now()
         AND ds.expires_at <= now() + interval '48 hours'
       ) AS near_expiry,
       pend.order_id AS pending_order_id,
       pend.status AS pending_status,
       pend.created_at AS pending_created_at,
       pend.device_id AS pending_device_id,
       pend.raw_payload AS pending_raw_payload
     FROM (SELECT $1::text AS device_id) req
     LEFT JOIN device_subscriptions ds ON ds.device_id = req.device_id
     LEFT JOIN LATERAL (
       SELECT t.order_id, t.status, t.created_at, t.device_id, t.raw_payload
       FROM transactions t
       WHERE t.device_id = req.device_id
         AND t.status = 'pending'
         AND t.plan_id IS NOT NULL
         AND t.created_at >= now() - ($2::int * interval '1 minute')
       ORDER BY t.created_at DESC
       LIMIT 1
     ) pend ON true`,
    [d, mins],
  )
  const snap = rows[0]
  if (!snap) return { row: null, pendingTxn: null }
  const row = snap.device_id
    ? {
        device_id: snap.device_id,
        status: snap.status,
        expires_at: snap.expires_at,
        started_at: snap.started_at,
        updated_at: snap.updated_at,
        transaction_id: snap.transaction_id,
        admin_revoked_at: snap.admin_revoked_at,
        active_now: snap.active_now === true,
        blocked_now: snap.blocked_now === true,
        block_reason: snap.block_reason,
        remaining_seconds: snap.remaining_seconds,
        remaining_hours: snap.remaining_hours,
        remaining_days: snap.remaining_days,
        near_expiry: snap.near_expiry === true,
      }
    : null
  const pendingTxn = snap.pending_order_id
    ? {
        order_id: snap.pending_order_id,
        status: snap.pending_status,
        created_at: snap.pending_created_at,
        device_id: snap.pending_device_id,
        raw_payload: snap.pending_raw_payload,
      }
    : null
  return { row, pendingTxn }
}

/** Poll decision using snapshot pending txn when possible (avoids extra pending lookups). */
export async function resolveVerifyPollDecision(deviceId, orderIdHint, snapshot = null) {
  const d = String(deviceId ?? '').trim()
  const hint = String(orderIdHint ?? '').trim()
  if (hint) return shouldProviderPollOrderForVerify(d, hint)
  const pend = snapshot?.pendingTxn
  if (!pend?.order_id) return { poll: false, reason: 'no_recent_pending' }
  const txnDev = txnDeviceIdForVerify(pend)
  if (txnDev && txnDev !== d) {
    return { poll: false, reason: 'pending_device_mismatch' }
  }
  const status = String(pend.status ?? '')
  if (status !== 'pending') {
    return { poll: false, reason: `pending_${status || 'unknown'}` }
  }
  const ageMin = transactionCreatedAgeMinutes(pend)
  const maxMin = verifyPendingMaxAgeMinutes()
  if (ageMin > maxMin) {
    return {
      poll: false,
      reason: 'pending_stale',
      age_min: Math.round(ageMin),
      max_age_min: maxMin,
    }
  }
  const raw = pend.raw_payload && typeof pend.raw_payload === 'object' ? pend.raw_payload : {}
  return {
    poll: true,
    reason: 'recent_pending',
    age_min: Math.round(ageMin),
    provider: String(raw.payment_provider ?? 'zenopay'),
    order_id: String(pend.order_id),
  }
}

/**
 * Server-authoritative access check using PostgreSQL NOW() (never device time).
 */
export async function getDeviceSubscriptionAccessState(deviceId, fingerprint = null) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const fpHash =
    fingerprint && String(fingerprint).trim() ? hashDeviceFingerprint(fingerprint) : null
  const { rows } = await pool.query(
    `SELECT
       ds.device_id,
       ds.status,
       ds.expires_at,
       ds.started_at,
       ds.updated_at,
       ds.transaction_id,
       ds.admin_revoked_at,
       (ds.status = 'active' AND ds.expires_at > now()) AS active_now,
       (
         COALESCE(ds.manual_admin_blocked, false)
         OR COALESCE(ad.is_blocked, false)
         OR COALESCE(ir.status = 'blocked', false)
       ) AS blocked_now,
       COALESCE(NULLIF(ir.block_reason, ''), ad.block_reason) AS block_reason,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ds.expires_at - now())))::bigint)
         ELSE 0::bigint
       END AS remaining_seconds,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 3600.0)::int)
         ELSE 0
       END AS remaining_hours,
       CASE
         WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
         THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 86400.0)::int)
         ELSE 0
       END AS remaining_days,
       (
         ds.status = 'active'
         AND ds.expires_at IS NOT NULL
         AND ds.expires_at > now()
         AND ds.expires_at <= now() + interval '48 hours'
       ) AS near_expiry
     FROM device_subscriptions ds
     LEFT JOIN admin_devices ad
       ON ad.device_id = ds.device_id
       OR ($2::text IS NOT NULL AND ad.fingerprint_hash = $2::text)
     LEFT JOIN device_intelligence_registry ir ON ir.device_id = ds.device_id
     WHERE ds.device_id = $1
     LIMIT 1`,
    [d, fpHash],
  )
  if (rows[0]) return rows[0]
  const ir = await pool.query(
    `SELECT block_reason FROM device_intelligence_registry
     WHERE device_id = $1 AND status = 'blocked' LIMIT 1`,
    [d],
  )
  if (ir.rows[0]) {
    await setManualAdminBlocked(d, true)
    const retry = await pool.query(
      `SELECT
         ds.device_id,
         ds.status,
         ds.expires_at,
         ds.started_at,
         ds.updated_at,
         ds.transaction_id,
         ds.admin_revoked_at,
         (ds.status = 'active' AND ds.expires_at > now()) AS active_now,
         (
           COALESCE(ds.manual_admin_blocked, false)
           OR COALESCE(ad.is_blocked, false)
           OR COALESCE(ir.status = 'blocked', false)
         ) AS blocked_now,
         COALESCE(NULLIF(ir.block_reason, ''), ad.block_reason) AS block_reason,
         CASE
           WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
           THEN GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (ds.expires_at - now())))::bigint)
           ELSE 0::bigint
         END AS remaining_seconds,
         CASE
           WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
           THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 3600.0)::int)
           ELSE 0
         END AS remaining_hours,
         CASE
           WHEN ds.status = 'active' AND ds.expires_at IS NOT NULL AND ds.expires_at > now()
           THEN GREATEST(0, FLOOR((EXTRACT(EPOCH FROM (ds.expires_at - now()))) / 86400.0)::int)
           ELSE 0
         END AS remaining_days,
         (
           ds.status = 'active'
           AND ds.expires_at IS NOT NULL
           AND ds.expires_at > now()
           AND ds.expires_at <= now() + interval '48 hours'
         ) AS near_expiry
       FROM device_subscriptions ds
       LEFT JOIN admin_devices ad
         ON ad.device_id = ds.device_id
         OR ($2::text IS NOT NULL AND ad.fingerprint_hash = $2::text)
       LEFT JOIN device_intelligence_registry ir ON ir.device_id = ds.device_id
       WHERE ds.device_id = $1
       LIMIT 1`,
      [d, fpHash],
    )
    return retry.rows[0] ?? null
  }
  return null
}

/** Touch live presence only when a channel is active (avoids idle verify/SSE inflation). */
export async function touchLivePresence({ deviceId, country = null, channelId = null, channelName = null }) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const safeChannelId = sanitizePresenceText(channelId, 128)
  const safeChannelName = sanitizePresenceText(channelName, 128)
  if (!safeChannelId && !safeChannelName) return null
  const rawLab = normalizeLocationPayload({ country: country ?? '' })
  const safeCountry = rawLab ? sanitizePresenceText(rawLab, 120) : null
  const out = await upsertLiveSession(pool, {
    deviceId: d,
    channelId: safeChannelId,
    channelName: safeChannelName,
    country: safeCountry,
  })
  return { deviceId: d, country: safeCountry, channelId: out.channelId }
}

/** Legacy durations for older manual grants / offer codes. */
const MANUAL_GRANT_LEGACY_DURATION_DAYS = [1, 7, 30, 90]

/**
 * Allowed manual-grant / offer-code durations: legacy set ∪ active duration-based plan lengths.
 * Keeps admin aligned with GET /api/plans and subscription verify catalog.
 */
export async function getManualGrantAllowedDurationDays() {
  const rows = await listPlansWithSubscriberCounts().catch(() => [])
  const fromPlans = rows
    .filter((p) => p.is_active && p.expiry_type !== 'fixed')
    .map((p) => Math.max(1, Math.floor(Number(p.duration_days) || 0)))
    .filter((n) => Number.isFinite(n) && n >= 1)
  return new Set([...MANUAL_GRANT_LEGACY_DURATION_DAYS, ...fromPlans])
}

/**
 * Persist admin-entered phone like a completed payment (registry + synthetic txn row).
 * Idempotent per manual_grant:{grantId} order_id. Does not alter subscription expiry.
 */
export async function recordManualGrantPhoneAndTransaction(
  { deviceId, grantId, planId, phone },
  client = null,
) {
  const q = dbQuery(client)
  const d = String(deviceId ?? '').trim()
  const gid = Number(grantId)
  const pid = planId != null ? Number(planId) : null
  const orderId = `manual_grant:${gid}`
  if (!d || !Number.isSafeInteger(gid) || gid < 1) return { recorded: false, orderId }

  const phoneRaw = String(phone ?? '').trim()
  if (!phoneRaw) return { recorded: false, orderId }

  const { updateDevicePhone } = await import('./lib/devicePhoneStore.js')
  await updateDevicePhone({ deviceId: d, phone: phoneRaw }).catch((err) => {
    console.warn('[manual_grant] phone registry update failed:', err?.message || err)
  })

  let resolvedPlanId = Number.isFinite(pid) && pid > 0 ? pid : null
  let amount = null
  if (resolvedPlanId) {
    const plan = await getPlanRowByIdAny(resolvedPlanId)
    amount = plan?.price != null ? Number(plan.price) : null
  }

  await q(
    `INSERT INTO transactions (order_id, plan_id, phone, amount, currency, status, device_id, raw_payload)
     VALUES ($1, $2, $3, $4, 'TZS', 'completed', $5, $6::jsonb)
     ON CONFLICT (order_id) DO UPDATE SET
       phone = CASE
         WHEN trim(coalesce(EXCLUDED.phone::text, '')) <> '' THEN EXCLUDED.phone
         ELSE transactions.phone
       END,
       plan_id = COALESCE(EXCLUDED.plan_id, transactions.plan_id),
       device_id = COALESCE(EXCLUDED.device_id, transactions.device_id),
       raw_payload = COALESCE(transactions.raw_payload, '{}'::jsonb) || EXCLUDED.raw_payload,
       updated_at = now()`,
    [
      orderId,
      resolvedPlanId,
      phoneRaw || null,
      amount,
      d,
      JSON.stringify({ payment_provider: 'manual_grant', source: 'manual_grant' }),
    ],
  )

  return { recorded: true, orderId }
}

export async function grantManualDeviceSubscription(deviceId, durationDays, client = null, opts = {}) {
  const q = dbQuery(client)
  const d = String(deviceId ?? '').trim()
  const days = Number(durationDays)
  const phone = String(opts.phone ?? '').trim()
  const allowed = await getManualGrantAllowedDurationDays()
  if (!d || !allowed.has(days)) {
    const list = [...allowed].sort((a, b) => a - b).join(', ')
    throw new Error(`Invalid device_id or duration_days (allowed: ${list})`)
  }

  let smsPhone = phone
  if (!smsPhone) {
    const resolved = await resolvePaymentPhoneForDevice(d)
    smsPhone = String(resolved?.phone ?? '').trim()
  }

  const plan = await getActivePlanByDurationDays(days)

  const ins = await q(
    `INSERT INTO manual_subscription_grants (device_id, duration_days, plan_id)
     VALUES ($1, $2, $3)
     RETURNING id, nonce`,
    [d, days, plan?.id ?? null],
  )
  const grantId = Number(ins.rows[0]?.id)
  const nonce = ins.rows[0]?.nonce
  if (!grantId || nonce == null) throw new Error('manual grant insert failed')

  const stack = await computeDeviceSubscriptionExpiryAfterPurchase(d, days, client)
  const expiresAt = stack.expiresAt
  const orderId = `manual_grant:${grantId}`

  const { skipped } = await upsertDeviceSubscriptionActive({ deviceId: d, orderId, expiresAt }, client)
  if (skipped) {
    console.warn('[manual_grant] unexpected upsert skip — order_id should be unique:', orderId)
  }

  await q(
    `UPDATE manual_subscription_grants SET expires_at_snapshot = $2::timestamptz WHERE id = $1`,
    [grantId, expiresAt],
  )

  await recordManualGrantPhoneAndTransaction(
    { deviceId: d, grantId, planId: plan?.id ?? null, phone: smsPhone || phone },
    client,
  )

  if (smsPhone) {
    void import('./lib/smsSubscriptionHooks.js')
      .then((m) =>
        m.notifyManualGrantActivated({
          deviceId: d,
          grantId,
          planId: plan?.id ?? null,
          planName: plan?.name ?? '',
          price: plan?.price != null ? Number(plan.price) : null,
          expiresAt,
          phone: smsPhone,
        }),
      )
      .catch((err) => console.warn('[sms] manual grant notify failed:', err))
  }

  publishManualGrantActivationRealtime(d, {
    grantId,
    nonce: String(nonce),
    durationDays: days,
    orderId,
  })

  return {
    grantId,
    nonce: String(nonce),
    expiresAt,
    durationDays: days,
    stackedFromExpiresAt: stack.previousExpiresAt ?? null,
    anchorAt: stack.anchorAt ?? null,
    skipped,
  }
}

function parseAdminTimestamptz(value, label) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid ${label}`)
  }
  return d
}

/**
 * Admin custom manual grant — exact start/expiry chosen by admin (no duration stacking).
 * Same gift popup + device_subscriptions activation path as {@link grantManualDeviceSubscription}.
 */
export async function grantCustomManualDeviceSubscription(
  deviceId,
  { planId, startedAt, expiresAt, createdBy = 'admin', phone },
  client = null,
) {
  const q = dbQuery(client)
  const d = String(deviceId ?? '').trim()
  const pid = Number(planId)
  const phoneRaw = String(phone ?? '').trim()
  const start = parseAdminTimestamptz(startedAt, 'started_at')
  const exp = parseAdminTimestamptz(expiresAt, 'expires_at')
  if (!d || !Number.isFinite(pid) || pid < 1) {
    throw new Error('device_id and plan_id are required')
  }
  if (!phoneRaw) {
    throw new Error('phone is required')
  }
  if (exp.getTime() <= start.getTime()) {
    throw new Error('expires_at must be later than started_at')
  }

  const plan = await getPlanRowByIdAny(pid)
  if (!plan || plan.deleted_at) {
    throw new Error('Plan not found')
  }
  const calendarMs = exp.getTime() - start.getTime()
  const days = Math.max(1, Math.ceil(calendarMs / (24 * 60 * 60 * 1000)))
  const creator = String(createdBy ?? 'admin').trim().slice(0, 256) || 'admin'

  const ins = await q(
    `INSERT INTO manual_subscription_grants (
       device_id, duration_days, plan_id, created_by, manual_custom, custom_expiry,
       started_at_custom, expires_at_custom
     )
     VALUES ($1, $2, $3, $4, true, true, $5::timestamptz, $6::timestamptz)
     RETURNING id, nonce`,
    [d, days, pid, creator, start.toISOString(), exp.toISOString()],
  )
  const grantId = Number(ins.rows[0]?.id)
  const nonce = ins.rows[0]?.nonce
  if (!grantId || nonce == null) throw new Error('manual custom grant insert failed')

  const orderId = `manual_grant:${grantId}`
  const { skipped } = await upsertDeviceSubscriptionActiveAt(
    { deviceId: d, orderId, expiresAt: exp.toISOString(), startedAt: start.toISOString() },
    client,
  )
  if (skipped) {
    console.warn('[manual_grant_custom] unexpected upsert skip — order_id should be unique:', orderId)
  }

  await q(`UPDATE manual_subscription_grants SET expires_at_snapshot = $2::timestamptz WHERE id = $1`, [
    grantId,
    exp.toISOString(),
  ])

  await recordManualGrantPhoneAndTransaction({ deviceId: d, grantId, planId: pid, phone: phoneRaw }, client)

  void import('./lib/smsSubscriptionHooks.js')
    .then((m) =>
      m.notifyManualGrantActivated({
        deviceId: d,
        grantId,
        planId: pid,
        planName: String(plan.name ?? ''),
        price: plan.price != null ? Number(plan.price) : null,
        expiresAt: exp.toISOString(),
        phone: phoneRaw,
      }),
    )
    .catch((err) => console.warn('[sms] manual custom grant notify failed:', err))

  publishManualGrantActivationRealtime(d, {
    grantId,
    nonce: String(nonce),
    durationDays: days,
    orderId,
  })

  return {
    grantId,
    nonce: String(nonce),
    expiresAt: exp.toISOString(),
    startedAt: start.toISOString(),
    durationDays: days,
    planId: pid,
    planName: String(plan.name ?? ''),
    customExpiry: true,
    manualCustom: true,
    createdBy: creator,
    skipped,
  }
}

/** FIFO pending manual gift for verify popup (oldest unacknowledged grant first). */
export async function getOldestPendingManualGrant(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT g.id, g.nonce, g.duration_days, g.created_at
     FROM manual_subscription_grants g
     INNER JOIN device_subscriptions ds ON ds.device_id = g.device_id
     WHERE g.device_id = $1
       AND g.acknowledged_at IS NULL
       AND g.deleted_at IS NULL
       AND ds.status = 'active'
       AND ds.expires_at > now()
       AND COALESCE(ds.manual_admin_blocked, false) = false
       AND ds.transaction_id ~ '^manual_grant:[0-9]+$'
       AND g.id <= (regexp_replace(ds.transaction_id, '^manual_grant:', '')::bigint)
     ORDER BY g.created_at ASC
     LIMIT 1`,
    [d],
  )
  return rows[0] ?? null
}

/**
 * Acknowledge a pending manual gift by grant id (numeric string), UUID nonce, or nonce text match.
 * After a successful ack, clears the FIFO queue up to the current manual_grant transaction id
 * so verify does not return another popup on the next poll.
 */
export async function acknowledgeManualGrantFlexible(deviceId, ackKeyRaw) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  const key = String(ackKeyRaw ?? '').trim()
  if (!d || !key) return false

  let acked = false

  const digitsOnly = /^\d+$/.test(key)
  if (digitsOnly) {
    const id = Number(key)
    if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return false
    const byId = await pool.query(
      `UPDATE manual_subscription_grants
       SET acknowledged_at = now()
       WHERE device_id = $1 AND id = $2 AND acknowledged_at IS NULL AND deleted_at IS NULL`,
      [d, id],
    )
    if (Number(byId.rowCount) > 0) acked = true
  }

  if (!acked) {
    const byNonceText = await pool.query(
      `UPDATE manual_subscription_grants
       SET acknowledged_at = now()
       WHERE device_id = $1 AND acknowledged_at IS NULL AND deleted_at IS NULL
         AND lower(trim(nonce::text)) = lower(trim($2::text))`,
      [d, key],
    )
    acked = Number(byNonceText.rowCount) > 0
  }

  if (!acked) return false

  await pool.query(
    `UPDATE manual_subscription_grants g
     SET acknowledged_at = COALESCE(g.acknowledged_at, now())
     FROM device_subscriptions ds
     WHERE g.device_id = ds.device_id
       AND g.device_id = $1
       AND g.acknowledged_at IS NULL
       AND g.deleted_at IS NULL
       AND ds.status = 'active'
       AND ds.expires_at > now()
       AND ds.transaction_id ~ '^manual_grant:[0-9]+$'
       AND g.id <= (regexp_replace(ds.transaction_id, '^manual_grant:', '')::bigint)`,
    [d],
  )
  return true
}

/** @deprecated Prefer acknowledgeManualGrantFlexible — kept for call sites */
export async function acknowledgeManualGrantByNonce(deviceId, nonce) {
  return acknowledgeManualGrantFlexible(deviceId, nonce)
}

export function manualSubscriptionAdminDebugEnabled() {
  return (
    String(process.env.MANUAL_SUBSCRIPTION_ADMIN_DEBUG ?? '').trim() === '1' ||
    String(process.env.MANUAL_SUBSCRIPTION_BULK_DELETE_DEBUG ?? '').trim() === '1'
  )
}

/** Admin: history of manual grants (excludes soft-deleted rows). */
export async function listManualSubscriptionHistoryAdmin({ limit = 500 } = {}) {
  const pool = requirePool()
  const lim = Math.min(1000, Math.max(1, Number(limit) || 500))
  const { rows } = await pool.query(
    `SELECT
       g.id,
       g.device_id,
       g.duration_days,
       g.plan_id,
       g.created_by,
       g.manual_custom,
       g.custom_expiry,
       g.started_at_custom,
       g.expires_at_custom,
       g.created_at AS granted_at,
       g.expires_at_snapshot,
       p.name AS plan_name,
       COALESCE(ds.manual_admin_blocked, false) AS manual_admin_blocked,
       COALESCE(
         (SELECT bool_or(ad.is_blocked) FROM admin_devices ad WHERE ad.device_id = g.device_id),
         false
       ) AS admin_device_blocked,
       ds.expires_at AS subscription_expires_at,
       ds.status AS subscription_status,
       ds.transaction_id AS subscription_transaction_id,
       COALESCE(NULLIF(trim(t.phone::text), ''), NULLIF(trim(dpr.phone_number_raw::text), '')) AS grant_phone
     FROM manual_subscription_grants g
     LEFT JOIN device_subscriptions ds ON ds.device_id = g.device_id
     LEFT JOIN plans p ON p.id = g.plan_id
     LEFT JOIN transactions t ON t.order_id = ('manual_grant:' || g.id::text)
     LEFT JOIN device_phone_registry dpr ON dpr.device_id = g.device_id
     WHERE g.deleted_at IS NULL
     ORDER BY g.created_at DESC, g.id DESC
     LIMIT $1`,
    [lim],
  )

  if (manualSubscriptionAdminDebugEnabled()) {
    console.info(
      '[manual_subscription_history_rows]',
      JSON.stringify({
        at: new Date().toISOString(),
        rowCount: rows.length,
        idSample: rows.slice(0, 12).map((r) => r.id),
        deletedAtColumnCheck: rows[0] != null ? 'row_present' : 'empty',
      }),
    )
  }

  return rows.map((r) => {
    const snap = r.expires_at_snapshot
    const subExp = r.subscription_expires_at
    const rawExp = snap ?? subExp
    const expDate =
      rawExp instanceof Date ? rawExp : rawExp != null ? new Date(rawExp) : null
    const validTime = expDate != null && !Number.isNaN(expDate.getTime()) && expDate.getTime() > Date.now()
    const manualBlocked = r.manual_admin_blocked === true
    const deviceBlocked = r.admin_device_blocked === true
    const effectiveBlocked = manualBlocked || deviceBlocked
    const subscriptionActive =
      String(r.subscription_status ?? '') === 'active' && validTime && !effectiveBlocked

    return {
      id: Number(r.id),
      deviceId: String(r.device_id ?? ''),
      durationDays: Number(r.duration_days) || 0,
      planId: r.plan_id != null ? Number(r.plan_id) : null,
      planName: r.plan_name != null ? String(r.plan_name) : '',
      createdBy: r.created_by != null ? String(r.created_by) : null,
      manualCustom: r.manual_custom === true,
      customExpiry: r.custom_expiry === true,
      startedAtCustom:
        r.started_at_custom instanceof Date
          ? r.started_at_custom.toISOString()
          : r.started_at_custom != null
            ? new Date(r.started_at_custom).toISOString()
            : null,
      expiresAtCustom:
        r.expires_at_custom instanceof Date
          ? r.expires_at_custom.toISOString()
          : r.expires_at_custom != null
            ? new Date(r.expires_at_custom).toISOString()
            : null,
      grantedAt:
        r.granted_at instanceof Date ? r.granted_at.toISOString() : r.granted_at != null
          ? new Date(r.granted_at).toISOString()
          : null,
      expiresAt: expDate && !Number.isNaN(expDate.getTime()) ? expDate.toISOString() : null,
      phone: r.grant_phone != null ? String(r.grant_phone) : '',
      transactionId:
        r.subscription_transaction_id != null ? String(r.subscription_transaction_id) : '',
      manualAdminBlocked: manualBlocked,
      adminDeviceBlocked: deviceBlocked,
      effectiveBlocked,
      subscriptionActive,
    }
  })
}

/** Toggle manual admin block on device_subscriptions (playback follows verify / blocked_now). */
export async function setManualAdminBlocked(deviceId, blocked) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) throw new Error('device_id required')
  const b = Boolean(blocked)
  const { rowCount } = await pool.query(
    `UPDATE device_subscriptions
     SET manual_admin_blocked = $2, updated_at = now()
     WHERE device_id = $1`,
    [d, b],
  )
  if (Number(rowCount) > 0) {
    return { updated: true }
  }
  // Grant history can exist without a subscription row (legacy / edge). Upsert so bulk block/unblock applies to every device.
  const txnId = `admin_manual:${crypto.randomUUID()}`.replace(/-/g, '').slice(0, 120)
  await pool.query(
    `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, manual_admin_blocked, updated_at)
     VALUES ($1::text, 'pending', now() - interval '1 day', now(), $2::text, $3::boolean, now())
     ON CONFLICT (device_id) DO UPDATE SET
       manual_admin_blocked = EXCLUDED.manual_admin_blocked,
       updated_at = now()`,
    [d, txnId, b],
  )
  return { updated: true }
}

/** Normalize admin-supplied grant id list (dedupe, int bounds, max 500). */
export function normalizeManualGrantIdList(raw) {
  const arr = Array.isArray(raw) ? raw : []
  return [
    ...new Set(
      arr
        .map((x) =>
          typeof x === 'number' && Number.isFinite(x) ? Math.trunc(x) : parseInt(String(x ?? '').trim(), 10),
        )
        .filter((n) => Number.isFinite(n) && n >= 1 && n <= Number.MAX_SAFE_INTEGER),
    ),
  ].slice(0, 500)
}

/** Soft-delete a manual grant row from admin history (does not revoke subscription time). */
export async function softDeleteManualGrant(grantId) {
  const pool = requirePool()
  const id = Number(grantId)
  if (!Number.isFinite(id) || id < 1) throw new Error('Invalid grant id')
  const { rows } = await pool.query(
    `UPDATE manual_subscription_grants
     SET deleted_at = now()
     WHERE id = $1::bigint AND deleted_at IS NULL
     RETURNING id, device_id`,
    [id],
  )
  const row = rows[0]
  if (!row) return null
  return { id: Number(row.id), deviceId: String(row.device_id ?? '') }
}

/**
 * Bulk soft-delete grant history rows (admin PIN path). Single statement so all IDs match consistently.
 * @param {unknown[]} grantIds
 * @returns {Promise<{ deleted: number, notFound: number, rows: { id: number, deviceId: string }[] }>}
 */
export async function bulkSoftDeleteManualGrants(grantIds) {
  const pool = requirePool()
  const ids = normalizeManualGrantIdList(grantIds)
  if (ids.length === 0) {
    return { deleted: 0, notFound: 0, rows: [] }
  }
  const dbg = manualSubscriptionAdminDebugEnabled()
  if (dbg) {
    let idCol = null
    try {
      const col = await pool.query(
        `SELECT data_type, udt_name
         FROM information_schema.columns
         WHERE table_schema = current_schema()
           AND table_name = 'manual_subscription_grants'
           AND column_name = 'id'`,
      )
      idCol = col.rows[0] ?? null
    } catch (e) {
      idCol = { error: String(e?.message ?? e) }
    }
    const probe = await pool.query(
      `SELECT id, deleted_at
       FROM manual_subscription_grants
       WHERE id = ANY($1::bigint[])`,
      [ids],
    )
    console.info(
      '[manual_bulk_delete_pre]',
      JSON.stringify({
        at: new Date().toISOString(),
        requested: ids.length,
        requestedSample: ids.slice(0, 12),
        idColumn: idCol,
        probeRows: probe.rows,
      }),
    )
  }
  // unnest + join avoids rare driver/array binding issues with ANY($1::bigint[])
  const result = await pool.query(
    `UPDATE manual_subscription_grants AS g
     SET deleted_at = now()
     FROM unnest($1::bigint[]) AS u(id)
     WHERE g.id = u.id AND g.deleted_at IS NULL
     RETURNING g.id, g.device_id`,
    [ids],
  )
  const rows = result.rows
  const deleted = rows.length
  const notFound = ids.length - deleted
  if (dbg) {
    const verify = await pool.query(
      `SELECT id, deleted_at
       FROM manual_subscription_grants
       WHERE id = ANY($1::bigint[])`,
      [ids],
    )
    console.info(
      '[manual_bulk_delete_post]',
      JSON.stringify({
        at: new Date().toISOString(),
        updateRowCount: Number(result.rowCount),
        returningCount: rows.length,
        deleted,
        notFound,
        returnedIdsSample: rows.slice(0, 12).map((r) => r.id),
        verifyRows: verify.rows,
      }),
    )
  }
  return {
    deleted,
    notFound,
    rows: rows.map((r) => ({ id: Number(r.id), deviceId: String(r.device_id ?? '') })),
  }
}

const MANUAL_GRANT_ORDER_ID_RE = /^manual_grant:[0-9]+$/

function manualGrantOrderId(grantId) {
  const id = Number(grantId)
  if (!Number.isFinite(id) || id < 1) return null
  return `manual_grant:${id}`
}

/**
 * Soft-delete one manual grant and revoke subscription only when this grant is the active entitlement.
 * Never modifies payment, recovery, transfer, or offer-code subscriptions.
 * @param {number} grantId
 * @param {import('pg').PoolClient | null} [client]
 */
export async function deleteManualGrantWithRevoke(grantId, client = null) {
  const pool = requirePool()
  const ownClient = client == null
  const c = client ?? (await pool.connect())
  const id = Number(grantId)
  const orderId = manualGrantOrderId(id)
  if (!orderId) {
    if (ownClient) c.release()
    return { deleted: false, revoked: false, deviceId: null, grantId: id }
  }

  try {
    if (ownClient) await c.query('BEGIN')

    const grantRes = await c.query(
      `SELECT id, device_id FROM manual_subscription_grants
       WHERE id = $1::bigint AND deleted_at IS NULL
       FOR UPDATE`,
      [id],
    )
    const grant = grantRes.rows[0]
    if (!grant) {
      if (ownClient) await c.query('ROLLBACK')
      return { deleted: false, revoked: false, deviceId: null, grantId: id }
    }
    const deviceId = String(grant.device_id ?? '').trim()

    const delRes = await c.query(
      `UPDATE manual_subscription_grants SET deleted_at = now()
       WHERE id = $1::bigint AND deleted_at IS NULL
       RETURNING id`,
      [id],
    )
    if (!delRes.rows[0]) {
      if (ownClient) await c.query('ROLLBACK')
      return { deleted: false, revoked: false, deviceId, grantId: id }
    }

    let revoked = false
    if (deviceId) {
      const subRes = await c.query(
        `SELECT transaction_id FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`,
        [deviceId],
      )
      const txn = String(subRes.rows[0]?.transaction_id ?? '').trim()
      if (txn === orderId && MANUAL_GRANT_ORDER_ID_RE.test(txn)) {
        await c.query(
          `UPDATE device_subscriptions
           SET status = 'pending', updated_at = now()
           WHERE device_id = $1 AND transaction_id = $2`,
          [deviceId, orderId],
        )
        revoked = true
      }
    }

    if (ownClient) await c.query('COMMIT')
    return { deleted: true, revoked, deviceId, grantId: id }
  } catch (e) {
    if (ownClient) await c.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    if (ownClient) c.release()
  }
}

/**
 * Bulk delete + conditional revoke (single transaction, rollback on any failure).
 * @param {unknown[]} grantIds
 */
export async function bulkDeleteManualGrantsWithRevoke(grantIds) {
  const pool = requirePool()
  const ids = normalizeManualGrantIdList(grantIds)
  if (ids.length === 0) {
    return { deleted: 0, revoked: 0, notFound: 0, rows: [], deviceIds: [] }
  }
  const client = await pool.connect()
  const results = []
  try {
    await client.query('BEGIN')
    for (const id of ids) {
      results.push(await deleteManualGrantWithRevoke(id, client))
    }
    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
  const deletedRows = results.filter((r) => r.deleted)
  const deviceIds = [...new Set(deletedRows.map((r) => r.deviceId).filter(Boolean))]
  return {
    deleted: deletedRows.length,
    revoked: deletedRows.filter((r) => r.revoked).length,
    notFound: ids.length - deletedRows.length,
    rows: deletedRows,
    deviceIds,
  }
}

/** Delete all manual grant history rows; revoke only matching active manual_grant entitlements. */
export async function deleteAllManualGrantsWithRevoke() {
  const pool = requirePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows } = await client.query(
      `SELECT id FROM manual_subscription_grants WHERE deleted_at IS NULL ORDER BY id ASC FOR UPDATE`,
    )
    const results = []
    for (const r of rows) {
      results.push(await deleteManualGrantWithRevoke(Number(r.id), client))
    }
    await client.query('COMMIT')
    const deletedRows = results.filter((x) => x.deleted)
    const deviceIds = [...new Set(deletedRows.map((x) => x.deviceId).filter(Boolean))]
    return {
      deleted: deletedRows.length,
      revoked: deletedRows.filter((x) => x.revoked).length,
      deviceIds,
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

/**
 * Webhook-driven activation. Skips entirely if transaction_id (order_id) already applied.
 * Renewals overwrite the same device_id row with a newer order/expiry only when not a duplicate webhook.
 */
export async function upsertDeviceSubscriptionActive(
  { deviceId, orderId, expiresAt, fingerprintHash = null },
  client = null,
) {
  const q = dbQuery(client)
  const d = String(deviceId ?? '').trim()
  const oid = String(orderId ?? '').trim()
  const fp = fingerprintHash ? String(fingerprintHash).trim() : null
  if (!d || !oid) throw new Error('deviceId and orderId required')
  if (await deviceSubscriptionOrderAlreadyApplied(oid, client)) {
    console.log('[device_subscriptions] idempotent skip — transaction_id already applied:', oid)
    return { skipped: true }
  }
  try {
    await q(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, fingerprint_hash, manual_admin_blocked)
       VALUES ($1, 'active', $2::timestamptz, now(), $3, now(), $4, false)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         started_at = CASE
           WHEN device_subscriptions.expires_at > now() THEN device_subscriptions.started_at
           ELSE EXCLUDED.started_at
         END,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         manual_admin_blocked = false,
         admin_revoked_at = NULL,
         admin_revoked_by = NULL,
         admin_revocation_reason = NULL,
         admin_revoked_transaction_id = NULL,
         fingerprint_hash = COALESCE(EXCLUDED.fingerprint_hash, device_subscriptions.fingerprint_hash)`,
      [d, expiresAt, oid, fp],
    )
    console.log('[device_subscriptions] upsert active', {
      deviceId: d.length > 20 ? `${d.slice(0, 18)}…` : d,
      orderId: oid.length > 24 ? `${oid.slice(0, 22)}…` : oid,
    })
    void import('./lib/smsSubscriptionHooks.js')
      .then((m) => m.notifySubscriptionActivated({ deviceId: d, orderId: oid, expiresAt }))
      .catch((err) => console.warn('[sms] activation notify failed:', err))
    invalidateSubscriptionAccessCache(d)
    void persistDevicePhoneFromTransaction(d, oid)
  } catch (e) {
    if (e?.code === '23505') {
      console.log('[device_subscriptions] duplicate transaction_id (race):', oid)
      return { skipped: true }
    }
    throw e
  }
  return { skipped: false }
}

/**
 * Admin custom grant — sets exact started_at and expires_at (no stacking on started_at).
 */
export async function upsertDeviceSubscriptionActiveAt(
  { deviceId, orderId, expiresAt, startedAt },
  client = null,
) {
  const q = dbQuery(client)
  const d = String(deviceId ?? '').trim()
  const oid = String(orderId ?? '').trim()
  const exp = parseAdminTimestamptz(expiresAt, 'expires_at')
  const start = parseAdminTimestamptz(startedAt, 'started_at')
  if (!d || !oid) throw new Error('deviceId and orderId required')
  if (await deviceSubscriptionOrderAlreadyApplied(oid, client)) {
    console.log('[device_subscriptions] idempotent skip — transaction_id already applied:', oid)
    return { skipped: true }
  }
  try {
    await q(
      `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, updated_at, manual_admin_blocked)
       VALUES ($1, 'active', $2::timestamptz, $3::timestamptz, $4, now(), false)
       ON CONFLICT (device_id) DO UPDATE SET
         status = 'active',
         expires_at = EXCLUDED.expires_at,
         started_at = EXCLUDED.started_at,
         transaction_id = EXCLUDED.transaction_id,
         updated_at = now(),
         manual_admin_blocked = false`,
      [d, exp.toISOString(), start.toISOString(), oid],
    )
    invalidateSubscriptionAccessCache(d)
  } catch (e) {
    if (e?.code === '23505') {
      console.log('[device_subscriptions] duplicate transaction_id (race):', oid)
      return { skipped: true }
    }
    throw e
  }
  return { skipped: false }
}

/**
 * Idempotent activation for a completed transaction (webhook + payment-status poll).
 * Delegates to canonical activation engine.
 */
export async function tryActivateDeviceSubscriptionFromCompletedTxn(txn) {
  const { activateFromCompletedTxn } = await import('./lib/canonicalPaymentActivation.js')
  return activateFromCompletedTxn(txn)
}

/** Latest pending payment for this device (poll provider before subscription-status). */
export async function deviceHasPendingSubscriptionPayment(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return false
  const { rows } = await pool.query(
    `SELECT 1 AS ok
     FROM transactions
     WHERE device_id = $1
       AND status = 'pending'
       AND plan_id IS NOT NULL
     LIMIT 1`,
    [d],
  )
  return rows.length > 0
}

/** Max age (minutes) for in-flight checkout provider polls during subscription verify. */
export function verifyPendingMaxAgeMinutes(maxAgeMinutes = null) {
  const raw =
    maxAgeMinutes ??
    process.env.SUBSCRIPTION_VERIFY_PENDING_MAX_AGE_MINUTES ??
    process.env.SUBSCRIPTION_PENDING_MAX_AGE_MINUTES ??
    15
  return Math.max(5, Math.min(180, Number(raw) || 15))
}

function transactionCreatedAgeMinutes(txn) {
  if (!txn?.created_at) return Infinity
  const created = txn.created_at instanceof Date ? txn.created_at : new Date(txn.created_at)
  const ms = Date.now() - created.getTime()
  return Number.isFinite(ms) && ms >= 0 ? ms / 60_000 : Infinity
}

function txnDeviceIdForVerify(txn) {
  if (!txn) return ''
  let dev = String(txn.device_id ?? '').trim()
  if (!dev) {
    const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
    dev = String(raw.device_id ?? '').trim()
  }
  return dev
}

/**
 * Whether verify should poll SonicPesa/ZenoPay for a specific order_id hint.
 * Skips stale, completed, failed, or foreign-device orders (premium gate fast path).
 */
export async function shouldProviderPollOrderForVerify(deviceId, orderId) {
  const d = String(deviceId ?? '').trim()
  const oid = String(orderId ?? '').trim()
  if (!d || !oid) return { poll: false, reason: 'missing_ids' }
  const txn = await getTransactionByOrderId(oid)
  if (!txn) return { poll: false, reason: 'hint_txn_not_found' }
  const txnDev = txnDeviceIdForVerify(txn)
  if (txnDev && txnDev !== d) {
    return { poll: false, reason: 'hint_device_mismatch' }
  }
  const status = String(txn.status ?? '')
  if (status !== 'pending') {
    return { poll: false, reason: `hint_txn_${status || 'unknown'}` }
  }
  const ageMin = transactionCreatedAgeMinutes(txn)
  const maxMin = verifyPendingMaxAgeMinutes()
  if (ageMin > maxMin) {
    return {
      poll: false,
      reason: 'hint_pending_stale',
      age_min: Math.round(ageMin),
      max_age_min: maxMin,
    }
  }
  const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  return {
    poll: true,
    reason: 'hint_recent_pending',
    age_min: Math.round(ageMin),
    provider: String(raw.payment_provider ?? 'zenopay'),
    order_id: oid,
  }
}

/** Provider poll decision for subscription verify / premium channel gate. */
export async function shouldProviderPollForVerify(deviceId, orderIdHint) {
  const d = String(deviceId ?? '').trim()
  const hint = String(orderIdHint ?? '').trim()
  if (hint) return shouldProviderPollOrderForVerify(d, hint)
  const maxMin = verifyPendingMaxAgeMinutes()
  if (!(await deviceHasRecentPendingSubscriptionPayment(d, maxMin))) {
    return { poll: false, reason: 'no_recent_pending' }
  }
  const pend = await getLatestRecentPendingTransactionForDevice(d, maxMin)
  if (!pend?.order_id) return { poll: false, reason: 'no_recent_pending_row' }
  return shouldProviderPollOrderForVerify(d, String(pend.order_id))
}

/** Pending subscription payment started recently (in-flight checkout only). */
export async function deviceHasRecentPendingSubscriptionPayment(deviceId, maxAgeMinutes = null) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return false
  const mins = verifyPendingMaxAgeMinutes(maxAgeMinutes)
  const { rows } = await pool.query(
    `SELECT 1 AS ok
     FROM transactions
     WHERE device_id = $1
       AND status = 'pending'
       AND plan_id IS NOT NULL
       AND created_at >= now() - ($2::int * interval '1 minute')
     LIMIT 1`,
    [d, mins],
  )
  return rows.length > 0
}

let _verifyPlansCache = null
let _verifyPlansCacheAt = 0
const VERIFY_PLANS_TTL_MS = Math.max(5000, Number(process.env.VERIFY_PLANS_CACHE_MS) || 60_000)

/** Lightweight active plans for verify/checkout (no subscriber count join). */
export async function listActivePlansForVerify() {
  const now = Date.now()
  if (_verifyPlansCache && now - _verifyPlansCacheAt < VERIFY_PLANS_TTL_MS) {
    return _verifyPlansCache
  }
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT id, name, price, duration_days
     FROM plans
     WHERE deleted_at IS NULL AND is_active = true
     ORDER BY id ASC`,
  )
  _verifyPlansCache = rows
  _verifyPlansCacheAt = now
  return rows
}

export function invalidateVerifyPlansCache() {
  _verifyPlansCache = null
  _verifyPlansCacheAt = 0
}

/** Latest pending payment for this device (poll provider before subscription-status). */
export async function getLatestPendingTransactionForDevice(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT *
     FROM transactions
     WHERE device_id = $1
       AND status = 'pending'
       AND plan_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [d],
  )
  return rows[0] ?? null
}

/** Latest pending subscription txn within verify poll window (avoids stale pending rows). */
export async function getLatestRecentPendingTransactionForDevice(deviceId, maxAgeMinutes = null) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const mins = verifyPendingMaxAgeMinutes(maxAgeMinutes)
  const { rows } = await pool.query(
    `SELECT *
     FROM transactions
     WHERE device_id = $1
       AND status = 'pending'
       AND plan_id IS NOT NULL
       AND created_at >= now() - ($2::int * interval '1 minute')
     ORDER BY created_at DESC
     LIMIT 1`,
    [d, mins],
  )
  return rows[0] ?? null
}

export async function getLatestCompletedTransactionForDevice(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT *
     FROM transactions
     WHERE device_id = $1
       AND status = 'completed'
       AND plan_id IS NOT NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [d],
  )
  return rows[0] ?? null
}

async function getActivePlanByDurationDays(durationDays) {
  const pool = requirePool()
  const n = Number(durationDays)
  if (!Number.isFinite(n) || n < 1) return null
  const { rows } = await pool.query(
    `SELECT id, price, duration_days
     FROM plans
     WHERE deleted_at IS NULL
       AND is_active = true
       AND expiry_type <> 'fixed'
       AND duration_days = $1
     ORDER BY id ASC
     LIMIT 1`,
    [Math.trunc(n)],
  )
  return rows[0] ?? null
}

function timestampMs(v) {
  if (v == null || v === '') return 0
  const t = v instanceof Date ? v.getTime() : new Date(v).getTime()
  return Number.isFinite(t) ? t : 0
}

function toIsoTimestamp(v) {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}

function mergeVerifyTxnSummaries(primary, fallback) {
  if (!primary) return fallback
  if (!fallback) return primary
  return {
    ...fallback,
    ...primary,
    amount: primary.amount != null ? primary.amount : fallback.amount,
    currency: primary.currency != null ? primary.currency : fallback.currency,
    plan_id: primary.plan_id != null ? primary.plan_id : fallback.plan_id,
    plan_name: primary.plan_name != null ? primary.plan_name : fallback.plan_name,
    plan_duration_days:
      primary.plan_duration_days != null ? primary.plan_duration_days : fallback.plan_duration_days,
    started_at: primary.started_at != null ? primary.started_at : fallback.started_at,
    activated_at: primary.activated_at != null ? primary.activated_at : fallback.activated_at,
    source: primary.source != null ? primary.source : fallback.source,
    transaction_id: primary.transaction_id != null ? primary.transaction_id : fallback.transaction_id,
    grant_id: primary.grant_id != null ? primary.grant_id : fallback.grant_id,
  }
}

function verifySourceFromTransactionId(txnId) {
  const t = String(txnId ?? '').trim()
  if (t.startsWith('manual_grant:')) return 'manual_grant'
  if (t.startsWith('offer_code:')) return 'offer_code'
  if (t.startsWith('transfer:') || t.startsWith('force:')) return 'transfer'
  if (t.startsWith('recovery:')) return 'recovery'
  return 'payment'
}

/** Resolve plan/amount/duration from active entitlement when payment txn lookup is incomplete. */
async function buildEntitlementVerifyTxnSummary(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT
       ds.transaction_id,
       ds.started_at,
       ds.expires_at,
       COALESCE(pay.plan_id, lt.plan_id, mg.plan_id) AS plan_id,
       COALESCE(pay.amount, lt.amount, p.price) AS amount,
       COALESCE(pay.currency, lt.currency, 'TZS') AS currency,
       COALESCE(pay.updated_at, lt.updated_at, mg.created_at, ds.updated_at) AS activated_at,
       p.name AS plan_name,
       p.duration_days AS plan_duration_days,
       mg.duration_days AS grant_duration_days
     FROM device_subscriptions ds
     LEFT JOIN transactions pay
       ON pay.order_id = ds.transaction_id AND pay.status = 'completed'
     LEFT JOIN manual_subscription_grants mg ON (
       mg.deleted_at IS NULL
       AND mg.id = CASE
         WHEN ds.transaction_id ~ '^manual_grant:[0-9]+$'
         THEN (substring(ds.transaction_id from 14))::bigint
       END
     )
     LEFT JOIN LATERAL (
       SELECT t.plan_id, t.amount, t.currency, t.updated_at
       FROM transactions t
       WHERE t.device_id = ds.device_id AND t.status = 'completed'
       ORDER BY COALESCE(t.updated_at, t.created_at) DESC
       LIMIT 1
     ) lt ON true
     LEFT JOIN plans p ON p.id = COALESCE(pay.plan_id, lt.plan_id, mg.plan_id) AND p.deleted_at IS NULL
     WHERE ds.device_id = $1
       AND ds.status = 'active'
       AND ds.expires_at > now()
     LIMIT 1`,
    [d],
  )
  const row = rows[0]
  if (!row) return null

  const txnId = String(row.transaction_id ?? '').trim()
  let planDurationDays =
    row.plan_duration_days != null ? Math.trunc(Number(row.plan_duration_days)) : null
  if (planDurationDays == null || !Number.isFinite(planDurationDays) || planDurationDays < 1) {
    const grantDays = Number(row.grant_duration_days)
    if (Number.isFinite(grantDays) && grantDays >= 1) {
      planDurationDays = Math.trunc(grantDays)
    }
  }
  if (planDurationDays == null || planDurationDays < 1) {
    const startMs = toMs(row.started_at)
    const endMs = toMs(row.expires_at)
    if (startMs != null && endMs != null && endMs > startMs) {
      planDurationDays = Math.max(1, Math.ceil((endMs - startMs) / 86400000))
    }
  }

  let planName = row.plan_name != null ? String(row.plan_name).trim() || null : null
  let amount = row.amount != null ? Number(row.amount) : null
  const planId = row.plan_id != null ? Number(row.plan_id) : null
  if ((!planName || amount == null) && planDurationDays != null) {
    const plan = await getActivePlanByDurationDays(planDurationDays)
    if (plan) {
      const full = await getPlanRowByIdAny(plan.id)
      if (!planName && full?.name) planName = String(full.name).trim() || null
      if (amount == null && plan.price != null) amount = Number(plan.price)
    }
  }
  if (!planName && planId != null) {
    const plan = await getPlanRowByIdAny(planId)
    if (plan?.name) planName = String(plan.name).trim() || null
    if (amount == null && plan?.price != null) amount = Number(plan.price)
    if ((planDurationDays == null || planDurationDays < 1) && plan?.duration_days != null) {
      planDurationDays = Math.trunc(Number(plan.duration_days))
    }
  }
  if (amount == null) {
    const { rows: amtRows } = await pool.query(
      `SELECT amount, plan_id
       FROM transactions
       WHERE device_id = $1 AND status = 'completed' AND amount IS NOT NULL
       ORDER BY COALESCE(updated_at, created_at) DESC
       LIMIT 1`,
      [d],
    )
    if (amtRows[0]?.amount != null) amount = Number(amtRows[0].amount)
    else if (amtRows[0]?.plan_id != null) {
      const p = await getPlanRowByIdAny(Number(amtRows[0].plan_id))
      if (p?.price != null) amount = Number(p.price)
    }
  }
  if (amount == null && txnId.startsWith('recovery:')) {
    const sourceDev = txnId.slice('recovery:'.length).trim()
    if (sourceDev && sourceDev !== d) {
      const { rows: srcAmt } = await pool.query(
        `SELECT amount, plan_id
         FROM transactions
         WHERE device_id = $1 AND status = 'completed' AND amount IS NOT NULL
         ORDER BY COALESCE(updated_at, created_at) DESC
         LIMIT 1`,
        [sourceDev],
      )
      if (srcAmt[0]?.amount != null) amount = Number(srcAmt[0].amount)
      else if (srcAmt[0]?.plan_id != null) {
        const p = await getPlanRowByIdAny(Number(srcAmt[0].plan_id))
        if (p?.price != null) amount = Number(p.price)
      }
    }
  }
  if (amount == null && planDurationDays != null) {
    const { rows: priceRows } = await pool.query(
      `SELECT price FROM plans
       WHERE deleted_at IS NULL AND duration_days = $1
       ORDER BY is_active DESC, id ASC LIMIT 1`,
      [planDurationDays],
    )
    if (priceRows[0]?.price != null) amount = Number(priceRows[0].price)
  }
  if (amount == null && planDurationDays != null && planDurationDays > 60) {
    const { rows: tierRows } = await pool.query(
      `SELECT price FROM plans
       WHERE deleted_at IS NULL AND duration_days >= 30
       ORDER BY duration_days DESC, id ASC LIMIT 1`,
    )
    if (tierRows[0]?.price != null) amount = Number(tierRows[0].price)
  }

  return {
    amount,
    currency: String(row.currency ?? 'TZS').trim() || 'TZS',
    plan_id: planId,
    plan_name:
      planName ||
      (planDurationDays != null ? `Kifurushi ${planDurationDays} siku` : 'Kifurushi'),
    plan_duration_days: planDurationDays,
    started_at: toIsoTimestamp(row.started_at),
    activated_at: toIsoTimestamp(row.activated_at),
    source: verifySourceFromTransactionId(txnId),
    transaction_id: txnId || null,
  }
}

function toMs(v) {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

/** Latest non-deleted manual / offer-code grant row for a device. */
export async function getLatestManualSubscriptionGrantRecord(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT id, duration_days, plan_id, created_at, custom_expiry, started_at_custom, expires_at_custom
     FROM manual_subscription_grants
     WHERE device_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [d],
  )
  return rows[0] ?? null
}

/**
 * True when the newest manual grant should win over verify repair + payment txn metadata
 * (grant created at or after the latest completed payment).
 */
export function manualGrantIsNewerThanCompletedPayment(grant, completedTxn) {
  if (!grant) return false
  if (!completedTxn) return true
  const grantMs = timestampMs(grant.created_at)
  const txnMs = timestampMs(
    completedTxn.completed_at ?? completedTxn.updated_at ?? completedTxn.created_at,
  )
  return grantMs >= txnMs
}

export async function manualGrantOverridesCompletedPayment(deviceId) {
  const d = String(deviceId ?? '').trim()
  const grant = await getLatestManualSubscriptionGrantRecord(d)
  if (!grant) return { overrides: false, grant: null, txn: null }
  const txn = await getLatestCompletedTransactionForDevice(d)
  return {
    overrides: manualGrantIsNewerThanCompletedPayment(grant, txn),
    grant,
    txn,
  }
}

/** Restore manual_grant transaction_id link without changing expires_at (metadata + repair guard). */
export async function ensureManualGrantTransactionLink(deviceId, grantId, client = null) {
  const q = dbQuery(client)
  const d = String(deviceId ?? '').trim()
  const gid = Number(grantId)
  if (!d || !Number.isSafeInteger(gid) || gid < 1) return { updated: false }
  const orderId = `manual_grant:${gid}`
  const { rowCount } = await q(
    `UPDATE device_subscriptions
     SET transaction_id = $2, updated_at = now()
     WHERE device_id = $1
       AND transaction_id IS DISTINCT FROM $2`,
    [d, orderId],
  )
  return { updated: Number(rowCount) > 0, transaction_id: orderId }
}

async function buildManualGrantSubscriptionTxnSummary(grant, transactionId = null) {
  const durationDays = Number(grant?.duration_days)
  if (!Number.isFinite(durationDays) || durationDays < 1) return null
  const grantId = grant?.id != null ? Number(grant.id) : null
  const tid =
    transactionId != null
      ? String(transactionId)
      : grantId != null
        ? `manual_grant:${grantId}`
        : ''
  const storedPlanId = grant?.plan_id != null ? Number(grant.plan_id) : null
  let plan = storedPlanId ? await getPlanRowByIdAny(storedPlanId) : null
  if (!plan) plan = await getActivePlanByDurationDays(durationDays)
  let effectiveDurationDays = Math.trunc(durationDays)
  if (grant?.custom_expiry === true && grant?.started_at_custom && grant?.expires_at_custom) {
    const startMs = new Date(grant.started_at_custom).getTime()
    const endMs = new Date(grant.expires_at_custom).getTime()
    if (Number.isFinite(startMs) && Number.isFinite(endMs) && endMs > startMs) {
      effectiveDurationDays = Math.max(1, Math.ceil((endMs - startMs) / (24 * 60 * 60 * 1000)))
    }
  }
  return {
    amount: plan?.price != null ? Number(plan.price) : null,
    currency: 'TZS',
    plan_id: plan?.id != null ? Number(plan.id) : storedPlanId,
    plan_name: plan?.name != null ? String(plan.name).trim() || null : null,
    plan_duration_days: effectiveDurationDays,
    started_at:
      grant?.custom_expiry === true && grant?.started_at_custom
        ? toIsoTimestamp(grant.started_at_custom)
        : null,
    activated_at: toIsoTimestamp(grant?.created_at),
    source: 'manual_grant',
    transaction_id: tid,
    grant_id: grantId,
  }
}

async function getManualGrantSummaryFromSubscriptionTransactionId(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null

  const { rows } = await pool.query(
    `SELECT
       ds.transaction_id,
       g.id AS grant_id,
       g.duration_days,
       g.plan_id,
       g.custom_expiry,
       g.started_at_custom,
       g.expires_at_custom,
       g.created_at
     FROM device_subscriptions ds
     LEFT JOIN manual_subscription_grants g
       ON (
         g.deleted_at IS NULL
         AND g.id = CASE
           WHEN ds.transaction_id ~ '^manual_grant:[0-9]+$'
           THEN (substring(ds.transaction_id from 14))::bigint
         END
       )
     WHERE ds.device_id = $1
       AND ds.transaction_id LIKE 'manual_grant:%'
     ORDER BY ds.updated_at DESC
     LIMIT 1`,
    [d],
  )
  const row = rows[0]
  if (!row) return null

  if (row.grant_id != null) {
    return await buildManualGrantSubscriptionTxnSummary(
      {
        id: row.grant_id,
        duration_days: row.duration_days,
        plan_id: row.plan_id,
        custom_expiry: row.custom_expiry,
        started_at_custom: row.started_at_custom,
        expires_at_custom: row.expires_at_custom,
        created_at: row.created_at,
      },
      row.transaction_id,
    )
  }

  let durationDays = Number(row.duration_days)
  if (!Number.isFinite(durationDays) || durationDays < 1) {
    const fallback = await getLatestManualSubscriptionGrantRecord(d)
    if (!fallback) return null
    return await buildManualGrantSubscriptionTxnSummary(fallback, row.transaction_id)
  }

  return await buildManualGrantSubscriptionTxnSummary(
    { id: row.grant_id, duration_days: durationDays },
    row.transaction_id,
  )
}

/**
 * Manual grants (Toa Kifurushi + Offer Codes) do not create completed payment transactions.
 * Prefer the latest manual grant when it is newer than any completed payment so verify metadata
 * stays correct even if subscription-status repair overwrote transaction_id.
 */
async function getLatestManualGrantSubscriptionTxnSummary(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return null

  const { overrides, grant } = await manualGrantOverridesCompletedPayment(d)
  if (overrides && grant) {
    await ensureManualGrantTransactionLink(d, grant.id)
    return await buildManualGrantSubscriptionTxnSummary(grant)
  }

  return getManualGrantSummaryFromSubscriptionTransactionId(d)
}

export function phoneFromTransactionRow(txn) {
  if (!txn) return ''
  const direct = String(txn.phone ?? '').trim()
  if (direct) return direct
  const raw = txn.raw_payload && typeof txn.raw_payload === 'object' ? txn.raw_payload : {}
  const poll = raw.order_status_poll && typeof raw.order_status_poll === 'object' ? raw.order_status_poll : {}
  const pollData = poll.data && typeof poll.data === 'object' ? poll.data : {}
  const sonic = raw.sonicpesa && typeof raw.sonicpesa === 'object' ? raw.sonicpesa : {}
  const sonicData = sonic.data && typeof sonic.data === 'object' ? sonic.data : {}
  const aurax = raw.auraxpay && typeof raw.auraxpay === 'object' ? raw.auraxpay : {}
  const auraxData = aurax.data && typeof aurax.data === 'object' ? aurax.data : {}
  return String(
    raw.phoneNorm ??
      raw.phone ??
      raw.buyer_phone ??
      raw.customer_phone ??
      pollData.msisdn ??
      pollData.phone ??
      sonicData.msisdn ??
      aurax.customer_phone ??
      auraxData.phone ??
      auraxData.customer_phone ??
      '',
  ).trim()
}

/** Backfill transactions.phone when provider stored MSISDN only in raw_payload. */
export async function backfillTransactionPhoneIfMissing(orderId, phoneCandidate) {
  const oid = String(orderId ?? '').trim()
  const candidate = String(phoneCandidate ?? '').trim()
  if (!oid || !candidate) return null
  const txn = await getTransactionByOrderId(oid)
  if (!txn || String(txn.phone ?? '').trim()) return txn
  const digits = normalizePhoneDigits(candidate)
  const phone = /^255\d{9}$/.test(digits) ? `+${digits}` : candidate.slice(0, 32)
  return updateTransactionByOrderId(oid, { phone })
}

async function persistDevicePhoneFromTransaction(deviceId, orderId) {
  const d = String(deviceId ?? '').trim()
  const oid = String(orderId ?? '').trim()
  if (!d || !oid) return
  const txn = await getTransactionByOrderId(oid)
  const phone = phoneFromTransactionRow(txn)
  if (!phone) return
  try {
    const { saveDevicePhoneOnce } = await import('./lib/devicePhoneStore.js')
    await saveDevicePhoneOnce({ deviceId: d, phone })
  } catch (e) {
    console.warn('[device_phone_registry] payment phone persist skipped:', e?.message || e)
  }
}

/** E.164-style +255… when digits look like Tanzania mobile; otherwise trimmed raw. */
export function formatPaymentPhoneForDisplay(phone) {
  const p = String(phone ?? '').trim()
  if (!p) return ''
  const digits = normalizePhoneDigits(p)
  if (/^255\d{9}$/.test(digits)) return `+${digits}`
  if (p.startsWith('+')) return p.slice(0, 64)
  return p.slice(0, 64)
}

const TXN_PHONE_NONEMPTY = `trim(coalesce(t.phone::text, '')) <> ''`

/**
 * Resolve payment phone for a device (security reports, admin).
 * Priority: active subscription txn → latest completed payment → transfer-linked payment.
 */
export async function resolvePaymentPhoneForDevice(deviceId) {
  const d = String(deviceId ?? '').trim()
  if (!d) return { phone: '', source: null }

  const pool = requirePool()

  const { rows: activeRows } = await pool.query(
    `SELECT t.phone::text AS phone
     FROM device_subscriptions ds
     INNER JOIN transactions t ON t.order_id = ds.transaction_id
     WHERE ds.device_id = $1
       AND ds.status = 'active'
       AND ds.expires_at > now()
       AND ${TXN_PHONE_NONEMPTY}
     ORDER BY ds.updated_at DESC NULLS LAST, t.created_at DESC
     LIMIT 1`,
    [d],
  )
  if (activeRows[0]?.phone) {
    return {
      phone: formatPaymentPhoneForDisplay(activeRows[0].phone),
      source: 'active_subscription',
    }
  }

  const { rows: subRows } = await pool.query(
    `SELECT transaction_id::text AS transaction_id
     FROM device_subscriptions
     WHERE device_id = $1
     ORDER BY updated_at DESC NULLS LAST
     LIMIT 1`,
    [d],
  )
  const linkedTxnId = String(subRows[0]?.transaction_id ?? '').trim()
  if (linkedTxnId) {
    const { extractPaymentOrderIdFromSubscriptionTxn } = await import(
      './lib/smsSubscriptionPackageContext.js'
    )
    const orderId = extractPaymentOrderIdFromSubscriptionTxn(linkedTxnId) || linkedTxnId
    if (orderId && !orderId.startsWith('manual_grant:')) {
      const { rows: linkedTxnPhone } = await pool.query(
        `SELECT phone::text AS phone
         FROM transactions
         WHERE order_id = $1 AND trim(coalesce(phone::text, '')) <> ''
         LIMIT 1`,
        [orderId],
      )
      if (linkedTxnPhone[0]?.phone) {
        return {
          phone: formatPaymentPhoneForDisplay(linkedTxnPhone[0].phone),
          source: 'subscription_linked_payment',
        }
      }
    }
  }

  const completedTxn = await getLatestCompletedTransactionForDevice(d)
  const completedPhone = phoneFromTransactionRow(completedTxn)
  if (completedPhone) {
    return {
      phone: formatPaymentPhoneForDisplay(completedPhone),
      source: 'completed_payment',
    }
  }

  const { rows: transferTargetRows } = await pool.query(
    `SELECT t.phone::text AS phone
     FROM device_transfers dt
     INNER JOIN transactions t ON t.device_id = dt.source_device_id
       AND t.status = 'completed'
       AND t.plan_id IS NOT NULL
       AND ${TXN_PHONE_NONEMPTY}
     WHERE dt.status = 'completed'
       AND dt.target_device_id = $1
     ORDER BY COALESCE(dt.completed_at, dt.created_at) DESC
     LIMIT 1`,
    [d],
  )
  if (transferTargetRows[0]?.phone) {
    return {
      phone: formatPaymentPhoneForDisplay(transferTargetRows[0].phone),
      source: 'device_transfer',
    }
  }

  const { rows: transferSourceRows } = await pool.query(
    `SELECT t.phone::text AS phone
     FROM device_transfers dt
     INNER JOIN transactions t ON t.device_id = dt.target_device_id
       AND t.status = 'completed'
       AND t.plan_id IS NOT NULL
       AND ${TXN_PHONE_NONEMPTY}
     WHERE dt.status = 'completed'
       AND dt.source_device_id = $1
     ORDER BY COALESCE(dt.completed_at, dt.created_at) DESC
     LIMIT 1`,
    [d],
  )
  if (transferSourceRows[0]?.phone) {
    return {
      phone: formatPaymentPhoneForDisplay(transferSourceRows[0].phone),
      source: 'device_transfer',
    }
  }

  const { rows: anyTxnRows } = await pool.query(
    `SELECT phone::text AS phone
     FROM transactions
     WHERE device_id = $1
       AND status = 'completed'
       AND trim(coalesce(phone::text, '')) <> ''
     ORDER BY created_at DESC
     LIMIT 1`,
    [d],
  )
  if (anyTxnRows[0]?.phone) {
    return {
      phone: formatPaymentPhoneForDisplay(anyTxnRows[0].phone),
      source: 'completed_payment',
    }
  }

  const { rows: pendingTxnRows } = await pool.query(
    `SELECT phone::text AS phone
     FROM transactions
     WHERE device_id = $1
       AND trim(coalesce(phone::text, '')) <> ''
     ORDER BY created_at DESC
     LIMIT 1`,
    [d],
  )
  if (pendingTxnRows[0]?.phone) {
    return {
      phone: formatPaymentPhoneForDisplay(pendingTxnRows[0].phone),
      source: 'pending_or_recent_payment',
    }
  }

  const { rows: intelRows } = await pool.query(
    `SELECT phone_number::text AS phone
     FROM device_intelligence_registry
     WHERE device_id = $1
       AND trim(coalesce(phone_number::text, '')) <> ''
     LIMIT 1`,
    [d],
  )
  if (intelRows[0]?.phone) {
    return {
      phone: formatPaymentPhoneForDisplay(intelRows[0].phone),
      source: 'device_intelligence',
    }
  }

  const { rows: registryRows } = await pool.query(
    `SELECT phone_number_raw, phone_number_normalized
     FROM device_phone_registry
     WHERE device_id = $1 AND trim(coalesce(phone_number_normalized::text, '')) <> ''
     ORDER BY updated_at DESC
     LIMIT 1`,
    [d],
  )
  if (registryRows[0]?.phone_number_normalized) {
    const raw = String(registryRows[0].phone_number_raw ?? registryRows[0].phone_number_normalized)
    return {
      phone: formatPaymentPhoneForDisplay(raw),
      source: 'device_phone_registry',
    }
  }

  return { phone: '', source: null }
}

/**
 * Amount/currency/duration for subscription verify (Account screen).
 * Uses latest completed txn, then resolves duration from plans via plan_id (same as activation),
 * so duration_days does not depend on SQL JOIN quirks or nullable aggregates.
 */
async function buildTxnSummaryFromRow(txn) {
  if (!txn) return null
  const planId = txn.plan_id != null ? Number(txn.plan_id) : null
  const planRow = planId != null ? await getPlanRowByIdAny(planId) : null
  let planDurationDays = null
  if (planRow != null && planRow.duration_days != null) {
    const n = Number(planRow.duration_days)
    if (Number.isFinite(n) && n >= 0) planDurationDays = Math.trunc(n)
  }
  const status = String(txn.status ?? '').trim().toLowerCase()
  return {
    amount:
      txn.amount != null
        ? Number(txn.amount)
        : planRow?.price != null
          ? Number(planRow.price)
          : null,
    currency: txn.currency != null ? String(txn.currency).trim() || 'TZS' : 'TZS',
    plan_id: planId,
    plan_name: planRow?.name != null ? String(planRow.name).trim() || null : null,
    plan_duration_days: planDurationDays,
    activated_at:
      status === 'completed'
        ? toIsoTimestamp(txn.updated_at ?? txn.created_at)
        : null,
    source: 'payment',
  }
}

export async function getLatestCompletedSubscriptionTxnSummary(deviceId) {
  return resolveVerifyTxnSummaryForDevice(deviceId, new Set())
}

async function resolveVerifyTxnSummaryForDevice(deviceId, visited) {
  const d = String(deviceId ?? '').trim()
  if (!d || visited.has(d)) return null
  visited.add(d)

  const manualSummary = await getLatestManualGrantSubscriptionTxnSummary(d)
  if (manualSummary != null) {
    return manualSummary
  }

  let txn = await getLatestCompletedTransactionForDevice(deviceId)
  let recoverySource = null
  if (!txn) {
    const pool = requirePool()
    const { rows: subRows } = await pool.query(
      `SELECT transaction_id::text AS transaction_id
       FROM device_subscriptions
       WHERE device_id = $1
         AND status = 'active'
         AND expires_at > now()
       LIMIT 1`,
      [d],
    )
    const linkedId = String(subRows[0]?.transaction_id ?? '').trim()
    if (linkedId.startsWith('recovery:')) {
      recoverySource = linkedId.slice('recovery:'.length).trim()
      if (recoverySource && recoverySource !== d) {
        txn = await getLatestCompletedTransactionForDevice(recoverySource)
        if (!txn) {
          const srcSummary = await resolveVerifyTxnSummaryForDevice(recoverySource, visited)
          if (srcSummary) {
            const ent = await buildEntitlementVerifyTxnSummary(d)
            return mergeVerifyTxnSummaries({ ...ent, source: 'recovery' }, srcSummary)
          }
        }
      }
    } else if (linkedId.startsWith('transfer:') || linkedId.startsWith('force:')) {
      txn = await getLatestCompletedTransactionForDevice(d)
    } else if (linkedId.startsWith('offer_code:')) {
      const offerGrant = await getManualGrantSummaryFromSubscriptionTransactionId(d)
      if (offerGrant) return offerGrant
      txn = await getLatestCompletedTransactionForDevice(d)
    } else if (linkedId) {
      const { rows: orderRows } = await pool.query(
        `SELECT * FROM transactions
         WHERE order_id = $1 AND status = 'completed'
         LIMIT 1`,
        [linkedId],
      )
      txn = orderRows[0] ?? null
    }
  }
  if (!txn) {
    const entitlement = await buildEntitlementVerifyTxnSummary(d)
    if (entitlement && recoverySource) return { ...entitlement, source: 'recovery' }
    return entitlement
  }

  const out = await buildTxnSummaryFromRow(txn)
  if (!out) return buildEntitlementVerifyTxnSummary(d)

  const linkedId = String(
    (await getDeviceSubscriptionByDeviceId(d))?.transaction_id ?? '',
  ).trim()
  if (linkedId.startsWith('transfer:') || linkedId.startsWith('force:')) {
    out.source = 'transfer'
  } else if (linkedId.startsWith('recovery:')) {
    out.source = 'recovery'
  } else if (linkedId.startsWith('offer_code:')) {
    out.source = 'offer_code'
  }

  const entitlement = await buildEntitlementVerifyTxnSummary(d)
  const merged = mergeVerifyTxnSummaries(out, entitlement)

  if (process.env.SUBSCRIPTION_VERIFY_DEBUG === '1') {
    console.log('[subscription_duration_debug]', {
      deviceId: d.length > 22 ? `${d.slice(0, 20)}…` : d,
      latestTxnRow: {
        order_id: txn.order_id,
        plan_id: txn.plan_id,
        amount: txn.amount,
        currency: txn.currency,
      },
      normalizedPlanDurationDays: merged.plan_duration_days,
      entitlementFilled:
        entitlement != null &&
        (out.plan_name == null || out.amount == null || out.plan_duration_days == null),
    })
  }

  return merged
}

/** Repair path: completed txn exists but device_subscriptions not yet updated. */
export async function tryFinalizeActivationForDevice(deviceId) {
  const d = String(deviceId ?? '').trim()
  const { overrides, grant } = await manualGrantOverridesCompletedPayment(d)
  if (overrides && grant) {
    await ensureManualGrantTransactionLink(d, grant.id)
    return {
      ran: false,
      reason: 'manual_grant_takes_precedence',
      grantId: Number(grant.id),
    }
  }

  const { getAdminRevocationState, isAdminRevokedOrderBlocked } = await import(
    './lib/adminSubscriptionRevocation.js'
  )
  const revocation = await getAdminRevocationState(d)
  const txn = await getLatestCompletedTransactionForDevice(d)
  if (!txn) return { ran: false, reason: 'no_completed_txn' }
  if (isAdminRevokedOrderBlocked(revocation, txn.order_id)) {
    return { ran: false, reason: 'admin_revoked_order_blocked', orderId: txn.order_id }
  }
  const act = await tryActivateDeviceSubscriptionFromCompletedTxn(txn)
  return { ran: true, ...act }
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

/** --- SonicPesa settings (row id = 1) — separate provider from ZenoPay --- */

export async function getSonicpesaRow() {
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT * FROM sonicpesa_settings WHERE id = 1`)
  return rows[0] ?? null
}

/**
 * @param {object} d
 * @param {boolean} d.keep_api_key — when true, keep existing api_key
 */
export async function updateSonicpesaRowFull(d) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `UPDATE sonicpesa_settings SET
       enabled = $1,
       environment = $2,
       api_endpoint = $3,
       account_id = $4,
       webhook_url = $5,
       api_key = CASE WHEN $6::boolean THEN api_key ELSE $7 END,
       last_test_at = $8::timestamptz,
       last_test_ok = $9,
       last_test_message = $10,
       updated_at = now()
     WHERE id = 1
     RETURNING *`,
    [
      Boolean(d.enabled),
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

/** Record SonicPesa webhook receipt for admin diagnostics. */
export async function recordSonicpesaWebhookReceived(body, { engineeringProbe = false } = {}) {
  const pool = requirePool()
  const o = body && typeof body === 'object' ? body : {}
  const event = String(o.event ?? o.type ?? '').trim().slice(0, 128)
  const orderId = String(o.order_id ?? o.orderId ?? o.merchant_order_id ?? '').trim().slice(0, 128)
  if (engineeringProbe) {
    await pool.query(
      `UPDATE sonicpesa_settings SET
         last_engineering_probe_at = now(),
         last_webhook_order_id = $2,
         updated_at = now()
       WHERE id = 1`,
      [event, orderId],
    )
    return
  }
  await pool.query(
    `UPDATE sonicpesa_settings SET
       last_webhook_at = now(),
       last_provider_webhook_at = now(),
       last_webhook_event = $1,
       last_webhook_order_id = $2,
       updated_at = now()
     WHERE id = 1`,
    [event, orderId],
  )
}

function normalizeCheckoutProvider(raw) {
  const p = String(raw ?? 'zenopay').trim().toLowerCase()
  if (p === 'sonicpesa') return 'sonicpesa'
  if (p === 'auraxpay' || p === 'aurax') return 'auraxpay'
  return 'zenopay'
}

/** Checkout gateway selection (row id = 1). */
export async function getCheckoutPaymentSettings() {
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT * FROM checkout_payment_settings WHERE id = 1`)
  const row = rows[0]
  return {
    payment_provider: normalizeCheckoutProvider(row?.payment_provider),
    updated_at: row?.updated_at ?? null,
  }
}

export async function updateCheckoutPaymentProvider(paymentProvider) {
  const pool = requirePool()
  const p = normalizeCheckoutProvider(paymentProvider)
  if (p !== 'zenopay' && p !== 'sonicpesa' && p !== 'auraxpay') {
    throw new Error('payment_provider must be zenopay, sonicpesa, or auraxpay')
  }
  const { rows } = await pool.query(
    `INSERT INTO checkout_payment_settings (id, payment_provider, updated_at)
     VALUES (1, $1, now())
     ON CONFLICT (id) DO UPDATE SET payment_provider = EXCLUDED.payment_provider, updated_at = now()
     RETURNING *`,
    [p],
  )
  const result = {
    payment_provider: normalizeCheckoutProvider(rows[0]?.payment_provider),
    updated_at: rows[0]?.updated_at ?? null,
  }
  try {
    const { liveSyncBus } = await import('./lib/liveSyncBus.js')
    liveSyncBus.publish('config.checkout_payment_provider_changed', {
      topics: ['config'],
      payment_provider: result.payment_provider,
      synced_at: new Date().toISOString(),
    })
  } catch (e) {
    console.warn('[billing] checkout provider liveSync publish failed:', e)
  }
  return result
}

/** --- Aurax Pay settings (row id = 1) — additive third gateway --- */

export async function getAuraxpayRow() {
  const pool = requirePool()
  const { rows } = await pool.query(`SELECT * FROM auraxpay_settings WHERE id = 1`)
  return rows[0] ?? null
}

export async function updateAuraxpayRowFull(d) {
  const pool = requirePool()
  const { rows } = await pool.query(
    `UPDATE auraxpay_settings SET
       enabled = $1,
       environment = $2,
       api_endpoint = $3,
       account_id = $4,
       webhook_url = $5,
       api_key = CASE WHEN $6::boolean THEN api_key ELSE $7 END,
       webhook_secret = CASE WHEN $8::boolean THEN webhook_secret ELSE $9 END,
       last_test_at = $10::timestamptz,
       last_test_ok = $11,
       last_test_message = $12,
       updated_at = now()
     WHERE id = 1
     RETURNING *`,
    [
      Boolean(d.enabled),
      d.environment,
      d.api_endpoint,
      d.account_id,
      d.webhook_url,
      Boolean(d.keep_api_key),
      d.api_key ?? '',
      Boolean(d.keep_webhook_secret),
      d.webhook_secret ?? '',
      d.last_test_at ?? null,
      d.last_test_ok ?? null,
      d.last_test_message ?? null,
    ],
  )
  return rows[0]
}

export async function recordAuraxpayCreateOrderAttempt({
  url,
  apiStyle,
  httpStatus,
  responseBody,
  providerMessage,
}) {
  const pool = requirePool()
  await pool.query(
    `UPDATE auraxpay_settings SET
       last_create_order_at = now(),
       last_create_order_url = $1,
       last_create_order_api_style = $2,
       last_create_order_http_status = $3,
       last_create_order_response = $4::jsonb,
       updated_at = now()
     WHERE id = 1`,
    [
      String(url ?? '').slice(0, 512),
      String(apiStyle ?? '').slice(0, 32),
      Number(httpStatus) || 0,
      JSON.stringify({
        providerMessage: providerMessage || null,
        body: responseBody ?? null,
      }),
    ],
  )
}

export async function recordAuraxpayWebhookReceived(body) {
  const pool = requirePool()
  const o = body && typeof body === 'object' ? body : {}
  const event = String(o.event ?? o.type ?? '').trim().slice(0, 128)
  const orderId = String(o.order_id ?? o.orderId ?? o.merchant_order_id ?? '').trim().slice(0, 128)
  await pool.query(
    `UPDATE auraxpay_settings SET
       last_webhook_at = now(),
       last_webhook_event = $1,
       last_webhook_order_id = $2,
       updated_at = now()
     WHERE id = 1`,
    [event, orderId],
  )
}

// --- Offer codes (admin-generated; redeem uses manual grant + popup flow) ---


export function normalizeOfferCode(raw) {
  const s = String(raw ?? '').replace(/\D/g, '')
  if (s.length !== 6) return null
  return s
}

export function offerCodeAudit(action, extra = {}) {
  console.log('[offer_code]', JSON.stringify({ action, ...extra, timestamp: new Date().toISOString() }))
}

/** Device-centric brute-force lock for redeem attempts. */
export async function getOfferCodeDeviceLockState(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return { locked: false, remainingSeconds: 0 }
  const { rows } = await pool.query(
    `SELECT lock_until FROM offer_code_device_attempts WHERE device_id = $1`,
    [d],
  )
  const lu = rows[0]?.lock_until
  if (lu == null) return { locked: false, remainingSeconds: 0 }
  const end = lu instanceof Date ? lu : new Date(lu)
  const t = end.getTime()
  if (!Number.isFinite(t) || t <= Date.now()) return { locked: false, remainingSeconds: 0 }
  return { locked: true, remainingSeconds: Math.max(0, Math.ceil((t - Date.now()) / 1000)) }
}

export async function recordOfferCodeInvalidAttempt(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return

  const { rows } = await pool.query(
    `INSERT INTO offer_code_device_attempts (device_id, consecutive_failures, updated_at)
     VALUES ($1, 1, now())
     ON CONFLICT (device_id) DO UPDATE SET
       consecutive_failures = offer_code_device_attempts.consecutive_failures + 1,
       updated_at = now()
     RETURNING consecutive_failures, lock_tier`,
    [d],
  )
  const r = rows[0]
  if (!r || Number(r.consecutive_failures) < 3) return

  const tier = Number(r.lock_tier) || 0
  const seconds = Math.min(86400 * 7, 300 * 2 ** tier)
  await pool.query(
    `UPDATE offer_code_device_attempts
     SET lock_until = now() + ($2::bigint * interval '1 second'),
         lock_tier = lock_tier + 1,
         consecutive_failures = 0,
         updated_at = now()
     WHERE device_id = $1`,
    [d, seconds],
  )
}

export async function resetOfferCodeDeviceAttempts(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return
  await pool.query(
    `UPDATE offer_code_device_attempts
     SET consecutive_failures = 0,
         lock_tier = 0,
         lock_until = NULL,
         updated_at = now()
     WHERE device_id = $1`,
    [d],
  )
}

export async function insertOfferCodeRow({ durationDays, createdBy = 'admin' }) {
  const pool = requirePool()
  const days = Number(durationDays)
  const allowed = await getManualGrantAllowedDurationDays()
  if (!allowed.has(days)) {
    const list = [...allowed].sort((a, b) => a - b).join(', ')
    throw new Error(`Invalid duration_days (allowed: ${list})`)
  }
  const shelfDays = Math.min(
    3650,
    Math.max(1, Number(process.env.OFFER_CODE_SHELF_DAYS) || 365),
  )
  for (let attempt = 0; attempt < 100; attempt++) {
    const n = 100000 + crypto.randomInt(900000)
    const code = String(n)
    try {
      const { rows } = await pool.query(
        `INSERT INTO offer_codes (code, duration_days, created_by, expires_at, failed_attempts, lock_until)
         VALUES ($1, $2, $3, now() + ($4::int * interval '1 day'), 0, NULL)
         RETURNING id, code, duration_days, created_at, expires_at`,
        [code, days, String(createdBy || 'admin').slice(0, 120), shelfDays],
      )
      if (rows[0]) return rows[0]
    } catch (e) {
      if (e?.code === '23505') continue
      throw e
    }
  }
  throw new Error('Could not generate a unique offer code')
}

function offerCodeRowStatus(row, nowMs = Date.now()) {
  if (row.deleted_at != null) return 'DELETED'
  if (row.blocked === true) return 'BLOCKED'
  if (row.used_at != null) return 'USED'
  const exp = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at)
  if (Number.isFinite(exp.getTime()) && exp.getTime() <= nowMs) return 'EXPIRED'
  return 'UNUSED'
}

export async function listOfferCodesHistoryAdmin({ limit = 500 } = {}) {
  const pool = requirePool()
  const lim = Math.min(1000, Math.max(1, Number(limit) || 500))
  const { rows } = await pool.query(
    `SELECT id, code, duration_days, created_by, created_at, used_by_device, used_at, expires_at,
            blocked, deleted_at
     FROM offer_codes
     ORDER BY created_at DESC
     LIMIT $1`,
    [lim],
  )
  return rows.map((r) => ({
    id: Number(r.id),
    code: String(r.code ?? ''),
    durationDays: Number(r.duration_days) || 0,
    createdBy: String(r.created_by ?? ''),
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
    usedByDevice: r.used_by_device ? String(r.used_by_device) : null,
    usedAt:
      r.used_at instanceof Date ? r.used_at.toISOString() : r.used_at != null ? String(r.used_at) : null,
    expiresAt:
      r.expires_at instanceof Date ? r.expires_at.toISOString() : String(r.expires_at ?? ''),
    blocked: r.blocked === true,
    deletedAt:
      r.deleted_at instanceof Date ? r.deleted_at.toISOString() : r.deleted_at != null ? String(r.deleted_at) : null,
    status: offerCodeRowStatus(r),
  }))
}

export async function setOfferCodeBlockedByCode(rawCode, blocked) {
  const pool = requirePool()
  const code = normalizeOfferCode(rawCode)
  if (!code) throw new Error('Invalid code')
  const { rows } = await pool.query(
    `UPDATE offer_codes SET blocked = $2 WHERE code = $1 AND deleted_at IS NULL RETURNING code`,
    [code, Boolean(blocked)],
  )
  return rows[0] != null
}

export async function softDeleteOfferCodeByCode(rawCode) {
  const pool = requirePool()
  const code = normalizeOfferCode(rawCode)
  if (!code) throw new Error('Invalid code')
  const { rowCount } = await pool.query(
    `UPDATE offer_codes SET deleted_at = now() WHERE code = $1 AND deleted_at IS NULL`,
    [code],
  )
  return Number(rowCount) > 0
}

/**
 * Redeem offer code: single-use, uses {@link grantManualDeviceSubscription} inside a transaction.
 */
export async function redeemOfferCodeForDevice(deviceId, rawCode) {
  const d = String(deviceId ?? '').trim()
  const code = normalizeOfferCode(rawCode)
  if (!d || !code) {
    return { ok: false, error: 'device_id and offer_code are required' }
  }

  const lock = await getOfferCodeDeviceLockState(d)
  if (lock.locked) {
    return { ok: false, locked: true, remainingSeconds: lock.remainingSeconds }
  }

  const pool = requirePool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const sel = await client.query(
      `SELECT *
       FROM offer_codes
       WHERE code = $1
       FOR UPDATE`,
      [code],
    )
    const oc = sel.rows[0]

    async function rollbackAndFail(reason, auditKind) {
      await client.query('ROLLBACK')
      await recordOfferCodeInvalidAttempt(d)
      offerCodeAudit(auditKind || 'invalid_attempt', { device_id: d, code })
      return { ok: false, error: reason }
    }

    if (!oc || oc.deleted_at != null) {
      return await rollbackAndFail('Invalid or unknown code', 'invalid_attempt')
    }
    if (oc.blocked === true) {
      return await rollbackAndFail('Code is blocked', 'invalid_attempt')
    }
    if (oc.used_at != null) {
      return await rollbackAndFail('Code already used', 'invalid_attempt')
    }

    const expAt = oc.expires_at instanceof Date ? oc.expires_at : new Date(oc.expires_at)
    if (Number.isFinite(expAt.getTime()) && expAt.getTime() <= Date.now()) {
      return await rollbackAndFail('Code has expired', 'invalid_attempt')
    }

    const durationDays = Number(oc.duration_days)

    const grant = await grantManualDeviceSubscription(d, durationDays, client)

    const mark = await client.query(
      `UPDATE offer_codes
       SET used_by_device = $2, used_at = now()
       WHERE id = $1 AND used_at IS NULL AND deleted_at IS NULL`,
      [oc.id, d],
    )
    if (Number(mark.rowCount) === 0) {
      await client.query('ROLLBACK')
      return { ok: false, error: 'Code could not be redeemed' }
    }

    await client.query('COMMIT')
    await resetOfferCodeDeviceAttempts(d)
    offerCodeAudit('redeemed', { device_id: d, code, grant_id: grant.grantId })
    return { ok: true, grant }
  } catch (e) {
    try {
      await client.query('ROLLBACK')
    } catch {
      /* ignore */
    }
    throw e
  } finally {
    client.release()
  }
}
