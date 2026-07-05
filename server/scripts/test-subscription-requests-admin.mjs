#!/usr/bin/env node
/**
 * Integration tests: subscription request admin filters, ordering, safe delete.
 * Requires DATABASE_URL. Run: node server/scripts/test-subscription-requests-admin.mjs
 */
import { ensureBillingStorage, getPlanRowByIdAny } from '../src/billingStore.js'
import { getPool } from '../src/db/pool.js'
import {
  approveSubscriptionRequest,
  blockSubscriptionRequest,
  bulkDeleteSubscriptionRequests,
  countSubscriptionRequestsByStatus,
  createSubscriptionRequest,
  deleteSubscriptionRequest,
  listSubscriptionRequestsAdmin,
  rejectSubscriptionRequest,
} from '../src/lib/subscriptionRequestStore.js'

const PREFIX = `sr_test_${Date.now()}`

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

async function snapshotSubscription(deviceId) {
  const pool = getPool()
  const { rows } = await pool.query(`SELECT * FROM device_subscriptions WHERE device_id = $1`, [deviceId])
  return rows[0] ? JSON.parse(JSON.stringify(rows[0])) : null
}

async function getPlanId() {
  const pool = getPool()
  const { rows } = await pool.query(
    `SELECT id FROM plans WHERE deleted_at IS NULL AND is_active = true AND duration_days > 0 ORDER BY id LIMIT 1`,
  )
  if (!rows[0]) throw new Error('no active plan')
  return rows[0].id
}

async function seedRequest(deviceId, planId, status = 'PENDING', createdAt = null) {
  const row = await createSubscriptionRequest({
    deviceId,
    phone: '+255700000099',
    planId,
  })
  const pool = getPool()
  if (status !== 'PENDING') {
    if (status === 'APPROVED') {
      await approveSubscriptionRequest({ requestId: row.id, adminIdentity: 'test', reason: 'test' })
    } else if (status === 'REJECTED') {
      await rejectSubscriptionRequest({ requestId: row.id, adminIdentity: 'test', reason: 'test' })
    } else if (status === 'BLOCKED') {
      await blockSubscriptionRequest({ requestId: row.id, adminIdentity: 'test', reason: 'test' })
    }
  }
  if (createdAt) {
    await pool.query(`UPDATE subscription_requests SET created_at = $2::timestamptz WHERE id = $1`, [
      row.id,
      createdAt,
    ])
  }
  const { rows } = await pool.query(`SELECT * FROM subscription_requests WHERE id = $1`, [row.id])
  return rows[0]
}

async function testFilterIsolation(planId) {
  const pending = await seedRequest(`${PREFIX}_pending`, planId, 'PENDING')
  const approved = await seedRequest(`${PREFIX}_approved`, planId, 'APPROVED')
  const rejected = await seedRequest(`${PREFIX}_rejected`, planId, 'REJECTED')
  const blocked = await seedRequest(`${PREFIX}_blocked`, planId, 'BLOCKED')

  const all = await listSubscriptionRequestsAdmin({ status: 'all', search: PREFIX, limit: 50 })
  const allIds = new Set(all.map((r) => r.id))
  for (const id of [pending.id, approved.id, rejected.id, blocked.id]) {
    assert(allIds.has(id), `all tab missing id ${id}`)
  }

  const onlyPending = await listSubscriptionRequestsAdmin({ status: 'PENDING', search: PREFIX })
  assert(onlyPending.every((r) => r.status === 'PENDING'), 'pending filter leaked non-pending')
  assert(onlyPending.some((r) => r.id === pending.id), 'pending missing seed')

  const onlyApproved = await listSubscriptionRequestsAdmin({ status: 'APPROVED', search: PREFIX })
  assert(onlyApproved.every((r) => r.status === 'APPROVED'), 'approved filter leaked')
  assert(onlyApproved.some((r) => r.id === approved.id), 'approved missing seed')

  const onlyRejected = await listSubscriptionRequestsAdmin({ status: 'REJECTED', search: PREFIX })
  assert(onlyRejected.every((r) => r.status === 'REJECTED'), 'rejected filter leaked')
  assert(onlyRejected.some((r) => r.id === rejected.id), 'rejected missing seed')

  const onlyBlocked = await listSubscriptionRequestsAdmin({ status: 'BLOCKED', search: PREFIX })
  assert(onlyBlocked.every((r) => r.status === 'BLOCKED'), 'blocked filter leaked')
  assert(onlyBlocked.some((r) => r.id === blocked.id), 'blocked missing seed')

  const counts = await countSubscriptionRequestsByStatus()
  assert(typeof counts.all === 'number' && counts.all >= 4, 'status counts invalid')

  console.log('[filter-isolation] OK', { pending: pending.id, approved: approved.id })
  return { pending, approved, rejected, blocked }
}

async function testOrdering(planId) {
  const old = await seedRequest(`${PREFIX}_ord_old`, planId, 'PENDING', '2026-01-01T10:00:00Z')
  const mid = await seedRequest(`${PREFIX}_ord_mid`, planId, 'PENDING', '2026-06-01T10:00:00Z')
  const newest = await seedRequest(`${PREFIX}_ord_new`, planId, 'PENDING', '2026-07-05T10:00:00Z')

  const rows = await listSubscriptionRequestsAdmin({ status: 'PENDING', search: `${PREFIX}_ord`, limit: 10 })
  const ids = rows.map((r) => r.id)
  const ni = ids.indexOf(newest.id)
  const mi = ids.indexOf(mid.id)
  const oi = ids.indexOf(old.id)
  assert(ni >= 0 && mi >= 0 && oi >= 0, 'ordering seeds missing from list')
  assert(ni < mi && mi < oi, `expected newest→middle→old order got ${ids.join(',')}`)

  console.log('[ordering] OK', ids)
  return { old, mid, newest }
}

async function testSingleDeleteSafety(planId) {
  const deviceId = `${PREFIX}_del_single`
  const approved = await seedRequest(deviceId, planId, 'APPROVED')
  const before = await snapshotSubscription(deviceId)
  assert(before, 'approved request should have created subscription')

  const snap = {
    device_id: before.device_id,
    status: before.status,
    expires_at: before.expires_at ? new Date(before.expires_at).toISOString() : null,
    started_at: before.started_at ? new Date(before.started_at).toISOString() : null,
    transaction_id: before.transaction_id,
  }

  await deleteSubscriptionRequest({ requestId: approved.id, adminIdentity: 'test' })

  const afterReq = await listSubscriptionRequestsAdmin({ status: 'all', search: deviceId })
  assert(afterReq.length === 0, 'deleted request still listed')

  const afterSub = await snapshotSubscription(deviceId)
  assert(afterSub, 'subscription removed after request delete')
  assert(afterSub.device_id === snap.device_id, 'device_id changed')
  assert(afterSub.status === snap.status, 'status changed')
  assert(
    new Date(afterSub.expires_at).toISOString() === snap.expires_at,
    `expires_at changed ${snap.expires_at} → ${afterSub.expires_at}`,
  )
  assert(afterSub.transaction_id === snap.transaction_id, 'transaction_id changed')

  console.log('[single-delete-safety] OK', { requestId: approved.id, deviceId })
}

async function testBulkDeleteSafety(planId) {
  const d1 = `${PREFIX}_bulk_a`
  const d2 = `${PREFIX}_bulk_b`
  const d3 = `${PREFIX}_bulk_keep`
  const r1 = await seedRequest(d1, planId, 'APPROVED')
  const r2 = await seedRequest(d2, planId, 'APPROVED')
  const keep = await seedRequest(d3, planId, 'PENDING')

  const before1 = await snapshotSubscription(d1)
  const before2 = await snapshotSubscription(d2)
  const before3 = await snapshotSubscription(d3)
  assert(before1 && before2, 'bulk seeds need subscriptions')

  const out = await bulkDeleteSubscriptionRequests({ requestIds: [r1.id, r2.id], adminIdentity: 'test' })
  assert(out.deleted === 2, `expected 2 deleted got ${out.deleted}`)

  const remaining = await listSubscriptionRequestsAdmin({ status: 'all', search: PREFIX + '_bulk' })
  assert(remaining.some((r) => r.id === keep.id), 'unselected request removed')
  assert(!remaining.some((r) => r.id === r1.id), 'r1 still listed')
  assert(!remaining.some((r) => r.id === r2.id), 'r2 still listed')

  const after1 = await snapshotSubscription(d1)
  const after2 = await snapshotSubscription(d2)
  const after3 = await snapshotSubscription(d3)
  assert(new Date(after1.expires_at).toISOString() === new Date(before1.expires_at).toISOString(), 'bulk d1 expires changed')
  assert(new Date(after2.expires_at).toISOString() === new Date(before2.expires_at).toISOString(), 'bulk d2 expires changed')
  assert(!before3 && !after3, 'pending-only device should have no subscription')

  console.log('[bulk-delete-safety] OK')
}

async function cleanup() {
  const pool = getPool()
  await pool.query(
    `UPDATE subscription_requests SET deleted_at = now()
     WHERE device_id LIKE $1 AND deleted_at IS NULL`,
    [`${PREFIX}%`],
  )
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('DATABASE_URL required')
    process.exit(1)
  }
  await ensureBillingStorage()
  const planId = await getPlanId()
  const plan = await getPlanRowByIdAny(planId)
  assert(plan, 'plan missing')

  try {
    await testFilterIsolation(planId)
    await testOrdering(planId)
    await testSingleDeleteSafety(planId)
    await testBulkDeleteSafety(planId)
    console.log('\n[test-subscription-requests-admin] ALL PASSED\n')
  } finally {
    await cleanup()
  }
}

main().catch((e) => {
  console.error('[test-subscription-requests-admin] FAIL', e)
  process.exit(1)
})
