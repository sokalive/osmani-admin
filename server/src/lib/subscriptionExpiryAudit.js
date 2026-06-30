/**
 * Audit subscription expires_at against replayed payment/grant stacking history.
 * Stacking on active renewals is intentional (see subscriptionStacking.js).
 */
import { getPool } from '../db/pool.js'
import { computeStackedExpiryIso } from './subscriptionStacking.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'

const MS_TOLERANCE = 2 * 60 * 1000 // 2 minutes clock skew
const REPAIR_MIN_OVER_MS = 24 * 60 * 60 * 1000 // only auto-repair >1 day over-credit

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function maskId(id) {
  const s = String(id ?? '').trim()
  if (s.length <= 10) return `${s.slice(0, 4)}…`
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

function toMs(v) {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(v)
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

function isTransferOrRecoveryTxn(txnId) {
  const t = String(txnId ?? '').trim().toLowerCase()
  return (
    t.startsWith('transfer:') ||
    t.startsWith('recovery:') ||
    t.startsWith('force:') ||
    t.startsWith('moved:') ||
    t.startsWith('repair:')
  )
}

/**
 * Replay stacking from ordered credit events (payments + manual grants).
 * @param {Array<{ atMs: number; durationDays: number; kind: string; ref: string }>} events
 */
export function replayStackedExpiryFromEvents(events) {
  let current = null
  const steps = []
  for (const ev of events) {
    if (ev.absoluteExpiresAtMs != null) {
      current = new Date(ev.absoluteExpiresAtMs).toISOString()
      steps.push({
        ref: ev.ref,
        kind: ev.kind,
        duration_days: ev.durationDays,
        at: new Date(ev.atMs).toISOString(),
        expires_after: current,
        stacked: false,
        custom_absolute: true,
      })
      continue
    }
    const stack = computeStackedExpiryIso(current, ev.durationDays, ev.atMs)
    current = stack.expiresAt
    steps.push({
      ref: ev.ref,
      kind: ev.kind,
      duration_days: ev.durationDays,
      at: new Date(ev.atMs).toISOString(),
      expires_after: current,
      stacked: stack.stacked,
    })
  }
  return { expectedExpiresAt: current, steps }
}

/** Minimum expiry from the most recent successful payment alone (no stacking). */
export function computeLastPaymentFloorExpiry(events) {
  if (!events?.length) return null
  const last = events[events.length - 1]
  const atMs = last.atMs
  const days = Math.max(1, Math.trunc(Number(last.durationDays) || 0))
  if (!atMs || days < 1) return null
  return computeStackedExpiryIso(null, days, atMs).expiresAt
}

export async function loadCreditEventsForDevice(pool, deviceId) {
  const d = String(deviceId ?? '').trim()
  const events = []

  const { rows: txns } = await pool.query(
    `SELECT t.order_id,
            t.amount,
            t.currency,
            t.plan_id,
            COALESCE(t.updated_at, t.created_at) AS credited_at,
            p.duration_days,
            p.name AS plan_name,
            p.price AS plan_price
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE t.device_id = $1
       AND t.status = 'completed'
       AND p.duration_days IS NOT NULL
     ORDER BY COALESCE(t.updated_at, t.created_at) ASC`,
    [d],
  )
  for (const row of txns) {
    const atMs = toMs(row.credited_at)
    const days = Math.max(1, Math.trunc(Number(row.duration_days) || 0))
    if (!atMs || days < 1) continue
    events.push({
      atMs,
      durationDays: days,
      kind: 'payment',
      ref: String(row.order_id),
      plan_name: row.plan_name,
      plan_price: row.plan_price != null ? Number(row.plan_price) : null,
      amount: row.amount != null ? Number(row.amount) : null,
    })
  }

  const { rows: grants } = await pool.query(
    `SELECT id, duration_days, created_at, custom_expiry, started_at_custom, expires_at_custom
     FROM manual_subscription_grants
     WHERE device_id = $1
       AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [d],
  )
  for (const row of grants) {
    if (row.custom_expiry === true && row.expires_at_custom != null) {
      const startMs = toMs(row.started_at_custom) ?? toMs(row.created_at)
      const expMs = toMs(row.expires_at_custom)
      const days = Math.max(1, Math.trunc(Number(row.duration_days) || 0))
      if (!startMs || !expMs) continue
      events.push({
        atMs: startMs,
        absoluteExpiresAtMs: expMs,
        durationDays: days,
        kind: 'manual_grant_custom',
        ref: `manual_grant:${row.id}`,
      })
      continue
    }
    const atMs = toMs(row.created_at)
    const days = Math.max(1, Math.trunc(Number(row.duration_days) || 0))
    if (!atMs || days < 1) continue
    events.push({
      atMs,
      durationDays: days,
      kind: 'manual_grant',
      ref: `manual_grant:${row.id}`,
    })
  }

  events.sort((a, b) => a.atMs - b.atMs)
  return events
}

/** Bulk-load credit events for many devices (2 queries instead of N). */
async function loadCreditEventsForDevices(pool, deviceIds) {
  const ids = [...new Set(deviceIds.map((d) => String(d).trim()).filter(Boolean))]
  const byDevice = new Map(ids.map((id) => [id, []]))
  if (!ids.length) return byDevice

  const { rows: txns } = await pool.query(
    `SELECT t.device_id::text AS device_id,
            t.order_id,
            COALESCE(t.updated_at, t.created_at) AS credited_at,
            p.duration_days
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE t.device_id = ANY($1::text[])
       AND t.status = 'completed'
       AND p.duration_days IS NOT NULL
     ORDER BY COALESCE(t.updated_at, t.created_at) ASC`,
    [ids],
  )
  for (const row of txns) {
    const d = String(row.device_id)
    const atMs = toMs(row.credited_at)
    const days = Math.max(1, Math.trunc(Number(row.duration_days) || 0))
    if (!byDevice.has(d) || !atMs || days < 1) continue
    byDevice.get(d).push({
      atMs,
      durationDays: days,
      kind: 'payment',
      ref: String(row.order_id),
    })
  }

  const { rows: grants } = await pool.query(
    `SELECT device_id::text AS device_id, id, duration_days, created_at,
            custom_expiry, started_at_custom, expires_at_custom
     FROM manual_subscription_grants
     WHERE device_id = ANY($1::text[])
       AND deleted_at IS NULL
     ORDER BY created_at ASC`,
    [ids],
  )
  for (const row of grants) {
    const d = String(row.device_id)
    if (!byDevice.has(d)) continue
    if (row.custom_expiry === true && row.expires_at_custom != null) {
      const startMs = toMs(row.started_at_custom) ?? toMs(row.created_at)
      const expMs = toMs(row.expires_at_custom)
      const days = Math.max(1, Math.trunc(Number(row.duration_days) || 0))
      if (!startMs || !expMs) continue
      byDevice.get(d).push({
        atMs: startMs,
        absoluteExpiresAtMs: expMs,
        durationDays: days,
        kind: 'manual_grant_custom',
        ref: `manual_grant:${row.id}`,
      })
      continue
    }
    const atMs = toMs(row.created_at)
    const days = Math.max(1, Math.trunc(Number(row.duration_days) || 0))
    if (!atMs || days < 1) continue
    byDevice.get(d).push({
      atMs,
      durationDays: days,
      kind: 'manual_grant',
      ref: `manual_grant:${row.id}`,
    })
  }

  for (const list of byDevice.values()) {
    list.sort((a, b) => a.atMs - b.atMs)
  }
  return byDevice
}

function auditSubscriptionRow(sub, events) {
  const { expectedExpiresAt, steps } = replayStackedExpiryFromEvents(events)
  const actualMs = toMs(sub.expires_at)
  const expectedMs = toMs(expectedExpiresAt)
  const active = sub.active_now === true
  const cls = classifyRow({
    actualMs,
    expectedMs,
    events,
    txnId: sub.transaction_id,
    active,
  })
  const remainingDays =
    active && actualMs != null ? Math.max(0, Math.floor((actualMs - Date.now()) / 86400000)) : 0
  const lastDuration = events.length ? events[events.length - 1].durationDays : null
  const deviceId = String(sub.device_id)
  return {
    device_id_masked: maskId(deviceId),
    device_id: deviceId,
    active,
    actual_expires_at:
      sub.expires_at instanceof Date ? sub.expires_at.toISOString() : String(sub.expires_at),
    expected_expires_at: expectedExpiresAt,
    transaction_id: String(sub.transaction_id ?? ''),
    credit_events: events.length,
    replay_steps: steps,
    remaining_days: remainingDays,
    last_package_duration_days: lastDuration,
    ui_mismatch:
      active && lastDuration != null && remainingDays > lastDuration + 1 && cls.category === 'replay_match',
    ...cls,
  }
}

function classifyRow({ actualMs, expectedMs, events, txnId, active }) {
  if (!active || actualMs == null) {
    return { category: 'inactive_or_missing', repair_safe: false }
  }
  if (isTransferOrRecoveryTxn(txnId)) {
    return { category: 'transfer_or_recovery', repair_safe: false }
  }
  const lastEvent = events.length ? events[events.length - 1] : null
  if (lastEvent?.kind === 'manual_grant_custom') {
    return { category: 'custom_manual_grant', repair_safe: false }
  }
  if (events.length === 0) {
    return { category: 'no_credit_history', repair_safe: false }
  }
  if (expectedMs == null) {
    return { category: 'replay_failed', repair_safe: false }
  }
  const deltaMs = actualMs - expectedMs
  if (Math.abs(deltaMs) <= MS_TOLERANCE) {
    const last = events[events.length - 1]
    return {
      category: 'replay_match',
      repair_safe: false,
      last_payment_duration_days: last?.durationDays ?? null,
      stacked: events.length > 1,
    }
  }
  if (deltaMs > REPAIR_MIN_OVER_MS) {
    return {
      category: 'over_credited',
      repair_safe: true,
      over_ms: deltaMs,
      over_days: Math.round((deltaMs / 86400000) * 10) / 10,
    }
  }
  if (deltaMs > MS_TOLERANCE) {
    return {
      category: 'minor_over_credited',
      repair_safe: false,
      over_ms: deltaMs,
    }
  }
  if (deltaMs < -MS_TOLERANCE) {
    return {
      category: 'under_credited',
      repair_safe: false,
      under_ms: -deltaMs,
    }
  }
  return { category: 'replay_match', repair_safe: false }
}

/**
 * @param {{ limit?: number; deviceId?: string; sinceDays?: number }} opts
 */
export async function runSubscriptionExpiryAudit(opts = {}) {
  const pool = requirePool()
  const limit = Math.min(5000, Math.max(1, Number(opts.limit) || 2000))
  const sinceDays = Math.min(365, Math.max(1, Number(opts.sinceDays) || 90))
  const deviceFilter = String(opts.deviceId ?? '').trim()

  const { rows: plans } = await pool.query(
    `SELECT id, name, price, duration_days, is_active
     FROM plans
     WHERE deleted_at IS NULL
     ORDER BY price ASC, duration_days ASC`,
  )

  const offset = Math.max(0, Number(opts.offset) || 0)
  const params = [sinceDays]
  let deviceClause = ''
  if (deviceFilter) {
    params.push(deviceFilter)
    deviceClause = `AND ds.device_id = $${params.length}`
  }

  const { rows: subs } = await pool.query(
    `SELECT ds.device_id,
            ds.status,
            ds.expires_at,
            ds.started_at,
            ds.transaction_id,
            ds.updated_at,
            (ds.status = 'active' AND ds.expires_at > now()) AS active_now
     FROM device_subscriptions ds
     WHERE ds.expires_at > now() - ($1::int * interval '1 day')
       ${deviceClause}
     ORDER BY ds.expires_at DESC
     OFFSET ${offset}
     LIMIT ${limit}`,
    params,
  )

  const eventsByDevice = await loadCreditEventsForDevices(
    pool,
    subs.map((s) => s.device_id),
  )

  const categories = {
    replay_match: [],
    stacked_legitimate: [],
    over_credited: [],
    minor_over_credited: [],
    under_credited: [],
    transfer_or_recovery: [],
    no_credit_history: [],
    inactive_or_missing: [],
    replay_failed: [],
    ui_mismatch_only: [],
  }

  let audited = 0
  for (const sub of subs) {
    audited += 1
    const deviceId = String(sub.device_id)
    const events = eventsByDevice.get(deviceId) ?? []
    const row = auditSubscriptionRow(sub, events)
    const cls = { category: row.category, repair_safe: row.repair_safe }

    if (categories[cls.category]) {
      categories[cls.category].push(row)
    }
    if (row.ui_mismatch) {
      categories.ui_mismatch_only.push(row)
      if (cls.category === 'replay_match') {
        categories.stacked_legitimate.push(row)
      }
    }
  }

  const weeklyPlan = plans.find((p) => Number(p.price) === 3000 && Number(p.duration_days) === 7)

  return {
    audited_at: new Date().toISOString(),
    extension_policy: 'stack_on_active',
    extension_policy_detail:
      'Renewals add package duration_days onto remaining active time. plan_duration_days in verify is the last package length; remaining_days is total entitlement.',
    plans: plans.map((p) => ({
      id: p.id,
      name: p.name,
      price: Number(p.price),
      duration_days: Number(p.duration_days),
      is_active: p.is_active === true,
    })),
    weekly_3000_plan: weeklyPlan
      ? {
          id: weeklyPlan.id,
          name: weeklyPlan.name,
          price: Number(weeklyPlan.price),
          duration_days: Number(weeklyPlan.duration_days),
        }
      : null,
    users_audited: audited,
    summary: {
      replay_match: categories.replay_match.length,
      stacked_legitimate_ui_mismatch: categories.stacked_legitimate.length,
      ui_mismatch_only: categories.ui_mismatch_only.length,
      over_credited: categories.over_credited.length,
      minor_over_credited: categories.minor_over_credited.length,
      under_credited: categories.under_credited.length,
      transfer_or_recovery: categories.transfer_or_recovery.length,
      no_credit_history: categories.no_credit_history.length,
    },
    categories,
    samples: {
      over_credited: categories.over_credited.slice(0, 15),
      under_credited: categories.under_credited.slice(0, 10),
      ui_mismatch_only: categories.ui_mismatch_only.slice(0, 15),
      stacked_legitimate: categories.stacked_legitimate.slice(0, 10),
    },
  }
}

/**
 * Fast over-credit scan for repair batches (active subs only, ordered by highest expiry).
 */
async function findOverCreditedBatch({ limit = 50, offset = 0 } = {}) {
  const pool = requirePool()
  const { rows: subs } = await pool.query(
    `SELECT ds.device_id,
            ds.status,
            ds.expires_at,
            ds.started_at,
            ds.transaction_id,
            ds.updated_at,
            (ds.status = 'active' AND ds.expires_at > now()) AS active_now
     FROM device_subscriptions ds
     WHERE ds.status = 'active'
       AND ds.expires_at > now()
       AND ds.transaction_id NOT LIKE 'transfer:%'
       AND ds.transaction_id NOT LIKE 'recovery:%'
       AND ds.transaction_id NOT LIKE 'force:%'
     ORDER BY ds.expires_at DESC
     OFFSET $1
     LIMIT $2`,
    [Math.max(0, Number(offset) || 0), Math.min(200, Math.max(1, Number(limit) || 50))],
  )
  const eventsByDevice = await loadCreditEventsForDevices(
    pool,
    subs.map((s) => s.device_id),
  )
  const over = []
  for (const sub of subs) {
    const deviceId = String(sub.device_id)
    const events = eventsByDevice.get(deviceId) ?? []
    const row = auditSubscriptionRow(sub, events)
    if (row.category === 'over_credited' && row.repair_safe === true) {
      over.push(row)
    }
  }
  return over
}

/**
 * Repair clear over-credits (>1 day beyond replay). Never shortens below replay or payment floor.
 * @param {{ dryRun?: boolean; maxRepairs?: number; offset?: number; confirm?: boolean }} opts
 */
export async function repairSubscriptionExpiryOverCredits(opts = {}) {
  const dryRun = opts.dryRun !== false
  const confirm = opts.confirm === true
  if (!dryRun && !confirm) {
    return {
      dry_run: true,
      error:
        'Live repair requires dryRun=false and confirm=true. Use subscription-expiry-restore for safe uplift only.',
      repaired_count: 0,
      flagged_count: 0,
      repaired: [],
      flagged: [],
    }
  }
  const maxRepairs = Math.min(200, Math.max(1, Number(opts.maxRepairs) || 50))
  const offset = Math.max(0, Number(opts.offset) || 0)
  const scanLimit = Math.max(maxRepairs * 4, 80)
  const scanned = await findOverCreditedBatch({ limit: scanLimit, offset })
  const candidates = scanned
  const repaired = []
  const flagged = []

  for (const row of candidates.slice(0, maxRepairs)) {
    if (!row.expected_expires_at || !row.device_id) continue
    const expectedMs = toMs(row.expected_expires_at)
    const actualMs = toMs(row.actual_expires_at)
    if (expectedMs == null || actualMs == null || actualMs <= expectedMs + REPAIR_MIN_OVER_MS) {
      flagged.push({ ...row, reason: 'skipped_margin' })
      continue
    }

    const events = await loadCreditEventsForDevice(requirePool(), row.device_id)
    const floorIso = computeLastPaymentFloorExpiry(events)
    const floorMs = toMs(floorIso)
    const safeMs = Math.max(expectedMs, floorMs ?? 0)
    const nowMs = Date.now()

    if (safeMs <= nowMs + MS_TOLERANCE) {
      flagged.push({
        ...row,
        reason: 'would_deactivate_user',
        last_payment_floor: floorIso,
      })
      continue
    }
    if (safeMs < actualMs - MS_TOLERANCE) {
      flagged.push({ ...row, reason: 'would_reduce_expiry', safe_expires_at: new Date(safeMs).toISOString() })
      continue
    }
    if (!row.credit_events || row.credit_events < 1) {
      flagged.push({ ...row, reason: 'uncertain_no_credit_history' })
      continue
    }

    const targetIso = new Date(safeMs).toISOString()
    if (!dryRun) {
      const pool = requirePool()
      await pool.query(
        `UPDATE device_subscriptions
         SET expires_at = $2::timestamptz,
             status = 'active',
             updated_at = now()
         WHERE device_id = $1
           AND status = 'active'
           AND expires_at > now()
           AND expires_at > $2::timestamptz`,
        [row.device_id, targetIso],
      )
      invalidateSubscriptionAccessCache(row.device_id)
    }
    repaired.push({
      device_id_masked: row.device_id_masked,
      before_expires_at: row.actual_expires_at,
      after_expires_at: targetIso,
      over_days: row.over_days,
      dry_run: dryRun,
    })
  }

  return {
    dry_run: dryRun,
    offset,
    scanned_rows: scanned.length,
    candidates: candidates.length,
    repaired_count: repaired.length,
    flagged_count: flagged.length,
    repaired,
    flagged: flagged.slice(0, 20),
  }
}
