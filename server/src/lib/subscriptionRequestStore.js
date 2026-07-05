import { getPool } from '../db/pool.js'
import { getPlanRowByIdAny, grantManualDeviceSubscription, normalizePhoneDigits } from '../billingStore.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

export async function createSubscriptionRequest({
  deviceId,
  phone,
  planId,
  appVersion = null,
  runtimeVersion = null,
  metadata = {},
}) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  const phoneRaw = String(phone ?? '').trim()
  const pid = Number(planId)
  if (!d || !phoneRaw || !Number.isFinite(pid) || pid < 1) {
    throw new Error('device_id, phone, and plan_id are required')
  }

  const { readOmbaKifurushiEnabled, OMBA_KIFURUSHI_DISABLED_MESSAGE_SW } = await import(
    './subscriptionRequestSettings.js'
  )
  const enabled = await readOmbaKifurushiEnabled(pool)
  if (!enabled) {
    const err = new Error(OMBA_KIFURUSHI_DISABLED_MESSAGE_SW)
    err.code = 'OMBA_KIFURUSHI_DISABLED'
    err.status = 403
    throw err
  }

  const plan = await getPlanRowByIdAny(pid)
  if (!plan || plan.deleted_at) throw new Error('Plan not found')

  const normalized = normalizePhoneDigits(phoneRaw)

  const dup = await pool.query(
    `SELECT id FROM subscription_requests
     WHERE device_id = $1 AND status = 'PENDING' AND deleted_at IS NULL
     LIMIT 1`,
    [d],
  )
  if (dup.rows[0]) {
    const err = new Error('Una ombi linalosubiri tayari. Tafadhali subiri majibu ya muhudumu.')
    err.code = 'DUPLICATE_PENDING_REQUEST'
    err.status = 409
    err.existingRequestId = dup.rows[0].id
    throw err
  }

  const { rows } = await pool.query(
    `INSERT INTO subscription_requests (
       device_id, phone, normalized_phone, plan_id, plan_name_snapshot,
       duration_days, price_snapshot, app_version, runtime_version, request_metadata
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
     RETURNING *`,
    [
      d,
      phoneRaw,
      normalized,
      pid,
      String(plan.name ?? ''),
      Number(plan.duration_days) || 0,
      Number(plan.price) || 0,
      appVersion ? String(appVersion).slice(0, 64) : null,
      runtimeVersion ? String(runtimeVersion).slice(0, 64) : null,
      JSON.stringify(metadata && typeof metadata === 'object' ? metadata : {}),
    ],
  )
  return rows[0]
}

export async function listSubscriptionRequestsAdmin({ status = 'all', limit = 200, search = '' } = {}) {
  const pool = requirePool()
  const lim = Math.min(500, Math.max(1, Number(limit) || 200))
  const cond = ['sr.deleted_at IS NULL']
  const params = []
  let i = 1
  if (status && status !== 'all') {
    cond.push(`sr.status = $${i}`)
    params.push(String(status).toUpperCase())
    i += 1
  }
  const q = String(search ?? '').trim()
  if (q) {
    cond.push(
      `(sr.device_id ILIKE $${i} OR sr.phone ILIKE $${i} OR sr.normalized_phone ILIKE $${i} OR CAST(sr.id AS TEXT) = $${i + 1})`,
    )
    params.push(`%${q}%`, q)
    i += 2
  }
  params.push(lim)
  const { rows } = await pool.query(
    `SELECT sr.*,
            ds.status AS sub_status,
            ds.expires_at AS sub_expires_at,
            ds.transaction_id AS sub_transaction_id
     FROM subscription_requests sr
     LEFT JOIN device_subscriptions ds ON ds.device_id = sr.device_id
     WHERE ${cond.join(' AND ')}
     ORDER BY sr.created_at DESC, sr.id DESC
     LIMIT $${i}`,
    params,
  )
  return rows
}

/** Authoritative per-status counts (not limited by list pagination/search). */
export async function countSubscriptionRequestsByStatus() {
  const pool = requirePool()
  const { rows } = await pool.query(
    `SELECT status, COUNT(*)::int AS n
     FROM subscription_requests
     WHERE deleted_at IS NULL
     GROUP BY status`,
  )
  const counts = { all: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, BLOCKED: 0, CANCELLED: 0 }
  for (const r of rows) {
    const st = String(r.status ?? '').toUpperCase()
    const n = Number(r.n) || 0
    counts.all += n
    if (st in counts) counts[st] = n
  }
  return counts
}

export async function deleteSubscriptionRequest({ requestId, adminIdentity = 'admin' }) {
  const pool = requirePool()
  const rid = Number(requestId)
  if (!Number.isFinite(rid) || rid < 1) throw new Error('Invalid request id')
  const { rows } = await pool.query(
    `UPDATE subscription_requests SET
       deleted_at = now(),
       updated_at = now(),
       admin_decision_by = COALESCE(admin_decision_by, $2)
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [rid, String(adminIdentity).slice(0, 256)],
  )
  if (!rows[0]) throw new Error('Request not found')
  return { ok: true, request: rows[0] }
}

export async function bulkDeleteSubscriptionRequests({ requestIds, adminIdentity = 'admin' }) {
  const pool = requirePool()
  const ids = [
    ...new Set(
      (Array.isArray(requestIds) ? requestIds : [])
        .map((x) => Number(x))
        .filter((n) => Number.isFinite(n) && n >= 1),
    ),
  ].slice(0, 500)
  if (ids.length === 0) throw new Error('request_ids required')
  const { rows } = await pool.query(
    `UPDATE subscription_requests SET
       deleted_at = now(),
       updated_at = now(),
       admin_decision_by = COALESCE(admin_decision_by, $2)
     WHERE id = ANY($1::int[]) AND deleted_at IS NULL
     RETURNING id`,
    [ids, String(adminIdentity).slice(0, 256)],
  )
  const deletedIds = rows.map((r) => Number(r.id))
  return { ok: true, deleted: deletedIds.length, deletedIds, notFound: ids.length - deletedIds.length }
}

export async function approveSubscriptionRequest({
  requestId,
  adminIdentity = 'admin',
  reason = '',
  editedPlanId = null,
}) {
  const pool = requirePool()
  const rid = Number(requestId)
  if (!Number.isFinite(rid) || rid < 1) throw new Error('Invalid request id')

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    const { rows: reqRows } = await client.query(
      `SELECT * FROM subscription_requests WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [rid],
    )
    const req = reqRows[0]
    if (!req) throw new Error('Request not found')
    if (String(req.status) === 'APPROVED') {
      await client.query('COMMIT')
      return { ok: true, alreadyApproved: true, request: req }
    }
    if (String(req.status) !== 'PENDING') throw new Error(`Cannot approve request in status ${req.status}`)

    const finalPlanId = Number(editedPlanId ?? req.plan_id)
    const plan = await getPlanRowByIdAny(finalPlanId)
    if (!plan) throw new Error('Plan not found')

    const grant = await grantManualDeviceSubscription(req.device_id, plan.duration_days, client, {
      phone: req.phone,
    })

    await client.query(
      `UPDATE subscription_requests SET
         status = 'APPROVED',
         admin_decision_by = $2,
         admin_decision_at = now(),
         admin_reason = $3,
         approved_plan_id = $4,
         resulting_grant_id = $5,
         resulting_order_id = $6,
         subscription_expires_at = $7::timestamptz,
         updated_at = now()
       WHERE id = $1`,
      [
        rid,
        String(adminIdentity).slice(0, 256),
        String(reason ?? '').slice(0, 2000),
        finalPlanId,
        grant.grantId,
        `manual_grant:${grant.grantId}`,
        grant.expiresAt,
      ],
    )

    await client.query('COMMIT')

    const { rows: updated } = await pool.query(`SELECT * FROM subscription_requests WHERE id = $1`, [rid])
    return { ok: true, alreadyApproved: false, grant, request: updated[0] }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }
}

export async function rejectSubscriptionRequest({ requestId, adminIdentity = 'admin', reason = '' }) {
  const pool = requirePool()
  const rid = Number(requestId)
  const { rows } = await pool.query(
    `UPDATE subscription_requests SET
       status = 'REJECTED',
       admin_decision_by = $2,
       admin_decision_at = now(),
       admin_reason = $3,
       updated_at = now()
     WHERE id = $1 AND status = 'PENDING' AND deleted_at IS NULL
     RETURNING *`,
    [rid, String(adminIdentity).slice(0, 256), String(reason ?? '').slice(0, 2000)],
  )
  if (!rows[0]) throw new Error('Request not found or not pending')
  return { ok: true, request: rows[0] }
}

export async function blockSubscriptionRequest({ requestId, adminIdentity = 'admin', reason = '' }) {
  const pool = requirePool()
  const rid = Number(requestId)
  const { rows } = await pool.query(
    `UPDATE subscription_requests SET
       status = 'BLOCKED',
       admin_decision_by = $2,
       admin_decision_at = now(),
       admin_reason = $3,
       updated_at = now()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING *`,
    [rid, String(adminIdentity).slice(0, 256), String(reason ?? '').slice(0, 2000)],
  )
  if (!rows[0]) throw new Error('Request not found')
  return { ok: true, request: rows[0] }
}

export async function getSubscriptionRequestForDevice(deviceId) {
  const pool = requirePool()
  const d = String(deviceId ?? '').trim()
  if (!d) return null
  const { rows } = await pool.query(
    `SELECT * FROM subscription_requests
     WHERE device_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC LIMIT 5`,
    [d],
  )
  return rows
}
