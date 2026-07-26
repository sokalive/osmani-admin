/**
 * Lineage-aware audit and normalization for historically over-credited subscriptions.
 *
 * Safety properties:
 * - completed payments and undeleted manual grants are the only credit events;
 * - explicit transfer/recovery links are followed, phone numbers are never ownership evidence;
 * - payment/grant history is immutable;
 * - every changed device_subscriptions row is backed up in PostgreSQL in the same transaction;
 * - compare-and-swap prevents a concurrent payment from being overwritten;
 * - dry-run is the default and ambiguous lineages block live application.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from '../db/pool.js'
import { computeMidnightEatExpiryIso, computeRemainingCalendarDaysEat } from './subscriptionStacking.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { clearVerifyAccessInflightForDevice } from './verifyAccessSingleflight.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'
import { liveSyncBus } from './liveSyncBus.js'

const DAY_MS = 86_400_000
const TOLERANCE_MS = 2 * 60 * 1000
const MATERIAL_OVER_CREDIT_MS = DAY_MS

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function ms(value) {
  if (value == null || value === '') return null
  const n = new Date(value).getTime()
  return Number.isFinite(n) ? n : null
}

function iso(value) {
  const n = ms(value)
  return n == null ? null : new Date(n).toISOString()
}

function text(value) {
  return String(value ?? '').trim()
}

function parseRecoverySource(transactionId) {
  const value = text(transactionId)
  if (!value.startsWith('recovery:')) return ''
  return value.slice('recovery:'.length).trim()
}

function parseMovedSource(transactionId) {
  const value = text(transactionId)
  if (!value.startsWith('moved:')) return ''
  return value.slice('moved:'.length).split(':')[0]?.trim() ?? ''
}

class UnionFind {
  constructor() {
    this.parent = new Map()
  }

  add(value) {
    const key = text(value)
    if (key && !this.parent.has(key)) this.parent.set(key, key)
    return key
  }

  find(value) {
    const key = this.add(value)
    if (!key) return ''
    const parent = this.parent.get(key)
    if (parent === key) return key
    const root = this.find(parent)
    this.parent.set(key, root)
    return root
  }

  union(a, b) {
    const left = this.find(a)
    const right = this.find(b)
    if (left && right && left !== right) this.parent.set(right, left)
  }
}

function paymentEvent(row) {
  const duration = Math.trunc(Number(row.duration_days))
  const at = ms(row.completed_at) ?? ms(row.created_at)
  if (!text(row.order_id) || !Number.isFinite(duration) || duration < 1 || at == null) return null
  return {
    key: `payment:${text(row.order_id)}`,
    kind: 'payment',
    ref: text(row.order_id),
    device_id: text(row.device_id),
    plan_id: row.plan_id == null ? null : Number(row.plan_id),
    plan_name: row.plan_name == null ? null : String(row.plan_name),
    amount: row.amount == null ? null : Number(row.amount),
    currency: text(row.currency) || 'TZS',
    duration_days: duration,
    purchased_at: new Date(at).toISOString(),
    at_ms: at,
    completed_at_source: row.completed_at != null ? 'completed_at' : 'created_at',
  }
}

function grantEvent(row) {
  const duration = Math.trunc(Number(row.duration_days))
  const at = ms(row.started_at_custom) ?? ms(row.created_at)
  if (row.id == null || !Number.isFinite(duration) || duration < 1 || at == null) return null
  const absoluteMs = row.custom_expiry === true ? ms(row.expires_at_custom) : null
  if (row.custom_expiry === true && absoluteMs == null) return null
  return {
    key: `grant:${row.id}`,
    kind: row.custom_expiry === true ? 'manual_grant_custom' : 'manual_grant',
    ref: `manual_grant:${row.id}`,
    device_id: text(row.device_id),
    plan_id: row.plan_id == null ? null : Number(row.plan_id),
    plan_name: row.plan_name == null ? null : String(row.plan_name),
    amount: 0,
    currency: 'TZS',
    duration_days: duration,
    purchased_at: new Date(at).toISOString(),
    at_ms: at,
    absolute_expires_at: absoluteMs == null ? null : new Date(absoluteMs).toISOString(),
    absolute_ms: absoluteMs,
    created_by: row.created_by == null ? null : String(row.created_by),
  }
}

/**
 * Replay all independently evidenced credit events.
 * A lapsed/new entitlement uses the canonical midnight-EAT rule. A genuinely separate
 * paid/granted event received while time remains is stacked so paid time is not removed.
 */
export function replayCanonicalEntitlement(events) {
  let expiryMs = null
  let legitimateStacks = 0
  const steps = []

  for (const event of [...events].sort((a, b) => a.at_ms - b.at_ms || a.key.localeCompare(b.key))) {
    const before = expiryMs == null ? null : new Date(expiryMs).toISOString()
    let stacked = false
    if (event.absolute_ms != null) {
      expiryMs = event.absolute_ms
    } else if (expiryMs != null && expiryMs > event.at_ms) {
      expiryMs += event.duration_days * DAY_MS
      stacked = true
      legitimateStacks += 1
    } else {
      expiryMs = ms(computeMidnightEatExpiryIso(event.duration_days, event.at_ms))
    }
    steps.push({
      ref: event.ref,
      kind: event.kind,
      purchased_at: event.purchased_at,
      duration_days: event.duration_days,
      before_expires_at: before,
      after_expires_at: expiryMs == null ? null : new Date(expiryMs).toISOString(),
      stacked,
      custom_absolute: event.absolute_ms != null,
    })
  }

  return {
    expected_expires_at: expiryMs == null ? null : new Date(expiryMs).toISOString(),
    legitimate_stack_count: legitimateStacks,
    steps,
  }
}

async function loadEvidence(client) {
  const [subsRes, txnsRes, grantsRes, transfersRes] = await Promise.all([
    client.query(
      `SELECT ds.*
       FROM device_subscriptions ds
       WHERE ds.status = 'active'
         AND ds.expires_at > now()
         AND ds.admin_revoked_at IS NULL
       ORDER BY ds.device_id`,
    ),
    client.query(
      `SELECT t.order_id, t.device_id, t.plan_id, t.amount, t.currency,
              t.created_at, t.completed_at, p.name AS plan_name, p.duration_days
       FROM transactions t
       LEFT JOIN plans p ON p.id = t.plan_id
       WHERE t.status = 'completed'
         AND COALESCE(t.order_id, '') NOT LIKE 'manual_grant:%'
       ORDER BY COALESCE(t.completed_at, t.created_at), t.order_id`,
    ),
    client.query(
      `SELECT g.id, g.device_id, g.plan_id, g.duration_days, g.created_at,
              g.created_by, g.custom_expiry, g.started_at_custom, g.expires_at_custom,
              p.name AS plan_name
       FROM manual_subscription_grants g
       LEFT JOIN plans p ON p.id = g.plan_id
       WHERE g.deleted_at IS NULL
       ORDER BY COALESCE(g.started_at_custom, g.created_at), g.id`,
    ),
    client.query(
      `SELECT id, code, source_device_id, target_device_id, status, reason,
              created_at, completed_at
       FROM device_transfers
       WHERE status = 'completed'
       ORDER BY COALESCE(completed_at, created_at), id`,
    ),
  ])
  return {
    subscriptions: subsRes.rows,
    transactions: txnsRes.rows,
    grants: grantsRes.rows,
    transfers: transfersRes.rows,
  }
}

function buildLineage(evidence) {
  const uf = new UnionFind()
  const txnByOrder = new Map()
  for (const txn of evidence.transactions) {
    const deviceId = uf.add(txn.device_id)
    const orderId = text(txn.order_id)
    if (orderId) txnByOrder.set(orderId, txn)
    if (deviceId) uf.add(deviceId)
  }
  for (const grant of evidence.grants) uf.add(grant.device_id)
  for (const sub of evidence.subscriptions) uf.add(sub.device_id)

  for (const transfer of evidence.transfers) {
    uf.union(transfer.source_device_id, transfer.target_device_id)
  }
  for (const sub of evidence.subscriptions) {
    const deviceId = text(sub.device_id)
    const recoverySource = parseRecoverySource(sub.transaction_id)
    const movedSource = parseMovedSource(sub.transaction_id)
    if (recoverySource && recoverySource !== deviceId) uf.union(deviceId, recoverySource)
    if (movedSource && movedSource !== deviceId) uf.union(deviceId, movedSource)
    const linkedTxn = txnByOrder.get(text(sub.transaction_id))
    if (linkedTxn?.device_id) uf.union(deviceId, linkedTxn.device_id)
  }

  const devicesByRoot = new Map()
  for (const deviceId of uf.parent.keys()) {
    const root = uf.find(deviceId)
    if (!devicesByRoot.has(root)) devicesByRoot.set(root, new Set())
    devicesByRoot.get(root).add(deviceId)
  }
  return { uf, devicesByRoot, txnByOrder }
}

function buildEventsByRoot(evidence, lineage) {
  const byRoot = new Map()
  const add = (deviceId, event) => {
    if (!event) return
    const root = lineage.uf.find(deviceId)
    if (!root) return
    if (!byRoot.has(root)) byRoot.set(root, new Map())
    byRoot.get(root).set(event.key, event)
  }
  for (const txn of evidence.transactions) add(txn.device_id, paymentEvent(txn))
  for (const grant of evidence.grants) add(grant.device_id, grantEvent(grant))
  return byRoot
}

function actionFor(expectedMs, nowMs) {
  return expectedMs != null && expectedMs > nowMs ? 'recalculate_active_expiry' : 'remove_expired_entitlement'
}

export async function auditHistoricalSubscriptionNormalization({ includeAll = false } = {}) {
  const pool = requirePool()
  const evidence = await loadEvidence(pool)
  const lineage = buildLineage(evidence)
  const eventsByRoot = buildEventsByRoot(evidence, lineage)
  const activeByRoot = new Map()
  for (const sub of evidence.subscriptions) {
    const root = lineage.uf.find(sub.device_id)
    if (!activeByRoot.has(root)) activeByRoot.set(root, [])
    activeByRoot.get(root).push(text(sub.device_id))
  }

  const nowMs = Date.now()
  const rows = []
  for (const sub of evidence.subscriptions) {
    const deviceId = text(sub.device_id)
    const root = lineage.uf.find(deviceId)
    const events = [...(eventsByRoot.get(root)?.values() ?? [])]
      .sort((a, b) => a.at_ms - b.at_ms || a.key.localeCompare(b.key))
    const replay = replayCanonicalEntitlement(events)
    const actualMs = ms(sub.expires_at)
    const expectedMs = ms(replay.expected_expires_at)
    const deltaMs = actualMs != null && expectedMs != null ? actualMs - expectedMs : null
    const linkedDevices = [...(lineage.devicesByRoot.get(root) ?? new Set([deviceId]))].sort()
    const activeOwners = [...(activeByRoot.get(root) ?? [])].sort()
    const blockers = []
    if (!events.length) blockers.push('no_completed_payment_or_undeleted_grant_in_lineage')
    if (events.some((event) => event.plan_id == null && event.kind === 'payment')) {
      blockers.push('completed_payment_missing_plan')
    }
    if (activeOwners.length > 1) blockers.push('multiple_active_entitlements_in_lineage')
    const overCredited = deltaMs != null && deltaMs > TOLERANCE_MS
    const materiallyOverCredited = deltaMs != null && deltaMs > MATERIAL_OVER_CREDIT_MS
    const candidate = overCredited
    const lastEvent = events.at(-1) ?? null
    const paymentHistory = events.filter((event) => event.kind === 'payment')
    const grantHistory = events.filter((event) => event.kind !== 'payment')
    const row = {
      device_id: deviceId,
      subscription_id: text(sub.transaction_id),
      lineage_device_ids: linkedDevices,
      active_lineage_device_ids: activeOwners,
      status: text(sub.status),
      started_at: iso(sub.started_at),
      old_expires_at: iso(sub.expires_at),
      expected_expires_at: replay.expected_expires_at,
      old_remaining_days: computeRemainingCalendarDaysEat(sub.expires_at, nowMs),
      new_remaining_days: computeRemainingCalendarDaysEat(replay.expected_expires_at, nowMs),
      over_credited: overCredited,
      materially_over_credited: materiallyOverCredited,
      over_credit_ms: deltaMs != null && deltaMs > 0 ? deltaMs : 0,
      over_credit_days: deltaMs != null && deltaMs > 0 ? Math.round((deltaMs / DAY_MS) * 100) / 100 : 0,
      action: candidate ? actionFor(expectedMs, nowMs) : 'none',
      plan_id: lastEvent?.plan_id ?? null,
      plan_name: lastEvent?.plan_name ?? null,
      plan_price: lastEvent?.amount ?? null,
      purchased_duration_days: events.reduce((sum, event) => sum + event.duration_days, 0),
      purchase_date: lastEvent?.purchased_at ?? null,
      payment_count: paymentHistory.length,
      grant_count: grantHistory.length,
      payment_history: paymentHistory,
      grant_history: grantHistory,
      entitlement_stacked: replay.legitimate_stack_count > 0,
      legitimate_stack_count: replay.legitimate_stack_count,
      replay_steps: replay.steps,
      root_cause: candidate
        ? activeOwners.length > 1
          ? 'historical_migration_or_recovery_duplicate_with_inflated_expiry'
          : events.length > 1
            ? 'stored_expiry_exceeds_completed_payment_and_grant_replay'
            : 'stored_expiry_exceeds_single_purchased_or_granted_entitlement'
        : null,
      blockers,
      current_row: sub,
    }
    if (includeAll || candidate || blockers.length) rows.push(row)
  }

  const candidates = rows.filter((row) => row.over_credited)
  const blockers = rows.filter((row) => row.blockers.length)
  return {
    audited_at: new Date(nowMs).toISOString(),
    policy: {
      new_or_lapsed: 'purchase EAT calendar date + duration_days at 00:00 Africa/Dar_es_Salaam',
      valid_paid_overlap: 'stack each distinct completed payment/grant exactly once',
      ownership: 'explicit Device ID transfer/recovery lineage only; phone is never ownership evidence',
      material_over_credit_threshold_ms: MATERIAL_OVER_CREDIT_MS,
      correction_threshold_ms: TOLERANCE_MS,
    },
    totals: {
      active_subscriptions_audited: evidence.subscriptions.length,
      over_credited_discovered: candidates.length,
      materially_over_credited_discovered: candidates.filter((row) => row.materially_over_credited).length,
      corrections_ready: candidates.filter((row) => row.blockers.length === 0).length,
      corrections_blocked: candidates.filter((row) => row.blockers.length > 0).length,
      remove_expired_entitlement: candidates.filter(
        (row) => row.blockers.length === 0 && row.action === 'remove_expired_entitlement',
      ).length,
      keep_valid_remaining_time: candidates.filter(
        (row) => row.blockers.length === 0 && row.action === 'recalculate_active_expiry',
      ).length,
      legitimate_stacked: candidates.filter((row) => row.entitlement_stacked).length,
      ambiguous_or_missing_evidence: blockers.length,
    },
    candidates,
    blockers,
  }
}

async function ensureBackupTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS subscription_normalization_backups (
      id BIGSERIAL PRIMARY KEY,
      batch_id UUID NOT NULL,
      device_id TEXT NOT NULL,
      old_row JSONB NOT NULL,
      computed_evidence JSONB NOT NULL,
      new_status TEXT NOT NULL,
      new_expires_at TIMESTAMPTZ NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NOT NULL DEFAULT 'admin_ai',
      UNIQUE (batch_id, device_id)
    )
  `)
  await client.query(
    `CREATE INDEX IF NOT EXISTS subscription_normalization_backups_device_idx
     ON subscription_normalization_backups (device_id, applied_at DESC)`,
  )
}

export async function applyHistoricalSubscriptionNormalization({
  confirm = false,
  appliedBy = 'admin_ai',
} = {}) {
  if (!confirm) {
    return { ok: false, applied: false, error: 'confirm=true is required' }
  }
  const audit = await auditHistoricalSubscriptionNormalization()
  if (audit.totals.corrections_blocked > 0) {
    return {
      ok: false,
      applied: false,
      error: 'Normalization stopped: ambiguous or missing evidence exists.',
      audit,
    }
  }
  const candidates = audit.candidates
  const pool = requirePool()
  const client = await pool.connect()
  const batchId = randomUUID()
  const changed = []
  try {
    await client.query('BEGIN')
    await ensureBackupTable(client)
    for (const row of [...candidates].sort((a, b) => a.device_id.localeCompare(b.device_id))) {
      const locked = await client.query(
        `SELECT * FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`,
        [row.device_id],
      )
      const current = locked.rows[0]
      if (
        !current ||
        text(current.status) !== 'active' ||
        iso(current.expires_at) !== row.old_expires_at ||
        current.admin_revoked_at != null
      ) {
        throw new Error(`Concurrent subscription change detected for ${row.device_id}; no rows applied`)
      }
      const targetExpiry = row.expected_expires_at
      const targetStatus = ms(targetExpiry) > Date.now() ? 'active' : 'expired'
      await client.query(
        `INSERT INTO subscription_normalization_backups
           (batch_id, device_id, old_row, computed_evidence, new_status, new_expires_at, applied_by)
         VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5, $6::timestamptz, $7)`,
        [
          batchId,
          row.device_id,
          JSON.stringify(current),
          JSON.stringify({
            subscription_id: row.subscription_id,
            payment_history: row.payment_history,
            grant_history: row.grant_history,
            replay_steps: row.replay_steps,
            root_cause: row.root_cause,
          }),
          targetStatus,
          targetExpiry,
          text(appliedBy) || 'admin_ai',
        ],
      )
      const updated = await client.query(
        `UPDATE device_subscriptions
         SET status = $2,
             expires_at = $3::timestamptz,
             updated_at = now()
         WHERE device_id = $1
           AND status = 'active'
           AND expires_at = $4::timestamptz
           AND admin_revoked_at IS NULL
         RETURNING *`,
        [row.device_id, targetStatus, targetExpiry, row.old_expires_at],
      )
      if (updated.rowCount !== 1) {
        throw new Error(`Compare-and-swap failed for ${row.device_id}; no rows applied`)
      }
      changed.push({
        device_id: row.device_id,
        subscription_id: row.subscription_id,
        old_expires_at: row.old_expires_at,
        new_expires_at: targetExpiry,
        old_remaining_days: row.old_remaining_days,
        new_remaining_days: row.new_remaining_days,
        old_status: 'active',
        new_status: targetStatus,
        action: row.action,
      })
    }
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }

  for (const row of changed) {
    invalidateSubscriptionAccessCache(row.device_id)
    clearVerifyAccessInflightForDevice(row.device_id)
    deviceSubscriptionBus.emit('update', {
      deviceId: row.device_id,
      reason: 'historical_subscription_normalized',
    })
    liveSyncBus.publish('subscription_normalized', {
      topics: ['analytics'],
      device_id: row.device_id,
      batch_id: batchId,
      status: row.new_status,
      expires_at: row.new_expires_at,
    })
  }

  return {
    ok: true,
    applied: true,
    batch_id: batchId,
    backup_table: 'subscription_normalization_backups',
    corrected_count: changed.length,
    changed,
    preflight_totals: audit.totals,
  }
}
