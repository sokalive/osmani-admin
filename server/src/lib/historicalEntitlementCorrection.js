/**
 * Authorized historical entitlement correction (2026-09-15 EAT audit).
 * Reconstructs canonical no-stack midnight-EAT expiry from payment/grant evidence
 * using snapshotted plan_duration_days. Dry-run default; apply requires confirm.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from '../db/pool.js'
import {
  loadCreditEventsForDevices,
  replayStackedExpiryFromEvents,
} from './subscriptionExpiryAudit.js'
import { computeMidnightEatExpiryIso, eatMidnightUtcIso, SUBSCRIPTION_TZ } from './subscriptionStacking.js'
import { shouldRefuseCreditAlignmentToStartedAt } from './consumedTransactionEntitlement.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { clearVerifyAccessInflightForDevice } from './verifyAccessSingleflight.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'

const MS_TOLERANCE = 2 * 60 * 1000
const DAY_MS = 86_400_000

/** 2026-09-15 00:00:00 Africa/Dar_es_Salaam */
export const AUDIT_REFERENCE_ISO = eatMidnightUtcIso(2026, 9, 15)
export const AUDIT_REFERENCE_MS = Date.parse(AUDIT_REFERENCE_ISO)

export const CLASSIFICATION = Object.freeze({
  CORRECT: 'CORRECT',
  EXPIRED: 'EXPIRED',
  OVER_CREDITED: 'OVER-CREDITED',
  UNDER_CREDITED: 'UNDER-CREDITED',
  DUPLICATE_STACKED: 'DUPLICATE/STACKED',
  REVOKED: 'REVOKED',
  TRANSFERRED: 'TRANSFERRED',
  AMBIGUOUS: 'NEEDS_MANUAL_REVIEW',
})

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function toMs(v) {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(v)
  const ms = d.getTime()
  return Number.isFinite(ms) ? ms : null
}

function iso(v) {
  const ms = toMs(v)
  return ms == null ? null : new Date(ms).toISOString()
}

function text(v) {
  return String(v ?? '').trim()
}

function maskId(id) {
  const s = text(id)
  if (!s) return null
  if (s.length <= 10) return `${s.slice(0, 4)}…`
  return `${s.slice(0, 8)}…${s.slice(-4)}`
}

function isSpecialTxn(txnId) {
  const t = text(txnId).toLowerCase()
  return (
    t.startsWith('moved:') ||
    t.startsWith('transfer:') ||
    t.startsWith('recovery:') ||
    t.startsWith('force:') ||
    t.startsWith('repair:')
  )
}

function dedupeEvents(events) {
  const seen = new Set()
  const out = []
  for (const ev of [...events].sort((a, b) => a.atMs - b.atMs || text(a.ref).localeCompare(text(b.ref)))) {
    const key = `${ev.kind}:${ev.ref}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(ev)
  }
  return out
}

function classifySubscription(sub, canonicalMs, actualMs, events, auditMs) {
  if (sub.admin_revoked_at != null || text(sub.status).toLowerCase() === 'revoked') {
    return CLASSIFICATION.REVOKED
  }
  if (isSpecialTxn(sub.transaction_id)) {
    return CLASSIFICATION.TRANSFERRED
  }
  if (!events.length) {
    const txnId = text(sub.transaction_id)
    const status = text(sub.status).toLowerCase()
    // Admin-manual placeholders and pending rows with past expiry have no entitlement.
    if (
      (txnId.toLowerCase().startsWith('admin_manual:') || status === 'pending' || status === 'active') &&
      actualMs != null &&
      actualMs <= auditMs
    ) {
      return CLASSIFICATION.EXPIRED
    }
    return CLASSIFICATION.AMBIGUOUS
  }
  if (canonicalMs == null) {
    return CLASSIFICATION.AMBIGUOUS
  }
  const deltaMs = actualMs != null ? actualMs - canonicalMs : null
  const duplicateStack =
    events.length > 1 &&
    events.some((e, i) => events.slice(i + 1).some((f) => f.ref === e.ref && f.kind === e.kind))
  if (duplicateStack && deltaMs != null && Math.abs(deltaMs) > MS_TOLERANCE) {
    return CLASSIFICATION.DUPLICATE_STACKED
  }

  if (deltaMs != null && Math.abs(deltaMs) <= MS_TOLERANCE) {
    if (canonicalMs <= auditMs) return CLASSIFICATION.EXPIRED
    return CLASSIFICATION.CORRECT
  }
  if (deltaMs != null && deltaMs > MS_TOLERANCE) {
    if (canonicalMs <= auditMs) return CLASSIFICATION.EXPIRED
    return CLASSIFICATION.OVER_CREDITED
  }
  if (deltaMs != null && deltaMs < -MS_TOLERANCE) {
    return CLASSIFICATION.UNDER_CREDITED
  }
  return CLASSIFICATION.AMBIGUOUS
}

/** Migration batch touched many txn.updated_at values at once — never use for upward repair. */
const BULK_BACKFILL_AT_MS = Date.parse('2026-07-26T19:53:34.846Z')

function proposedMutation(classification, canonicalIso, sub, activationAtMs = null) {
  if (
    classification === CLASSIFICATION.REVOKED ||
    classification === CLASSIFICATION.TRANSFERRED ||
    classification === CLASSIFICATION.AMBIGUOUS ||
    classification === CLASSIFICATION.CORRECT
  ) {
    return null
  }
  if (!canonicalIso) return null
  if (classification === CLASSIFICATION.UNDER_CREDITED && activationAtMs === BULK_BACKFILL_AT_MS) {
    return null
  }
  const actualIso = iso(sub.expires_at)
  if (actualIso === canonicalIso) return null

  const targetMs = toMs(canonicalIso)
  const startMs = toMs(sub.started_at)
  // CRITICAL GUARD: never rewrite a legitimate activation to expires_at < started_at.
  if (startMs != null && targetMs != null && targetMs < startMs - MS_TOLERANCE) {
    return null
  }

  return {
    old_status: text(sub.status) || 'active',
    new_status: text(sub.status) || 'active',
    old_expires_at: actualIso,
    new_expires_at: canonicalIso,
    action:
      classification === CLASSIFICATION.UNDER_CREDITED
        ? 'restore_canonical_expiry'
        : classification === CLASSIFICATION.EXPIRED
          ? 'correct_to_expired_canonical'
          : 'remove_unauthorized_extra_time',
  }
}

/**
 * When subscription.started_at is later than the linked payment credit clock,
 * align that event to started_at so delayed completions are not treated as
 * old order-created purchases (the paid-renewal-after-expiry bug).
 */
function alignCreditEventsWithActivation(sub, events) {
  const txnId = text(sub.transaction_id)
  const startMs = toMs(sub.started_at)
  if (!txnId || startMs == null || isSpecialTxn(txnId) || !events?.length) return events
  let changed = false
  const out = events.map((ev) => {
    if (text(ev.ref) !== txnId) return ev
    if (ev.atMs >= startMs - MS_TOLERANCE) return ev
    const impliedExpiry = computeMidnightEatExpiryIso(ev.durationDays, ev.atMs)
    if (shouldRefuseCreditAlignmentToStartedAt(ev.atMs, startMs, impliedExpiry)) {
      return { ...ev, credit_alignment_refused: 'started_after_credit_window' }
    }
    changed = true
    return { ...ev, atMs: startMs, credit_aligned_to_started_at: true }
  })
  return changed ? out : events
}

function buildAuditRow(sub, events, auditMs) {
  const aligned = alignCreditEventsWithActivation(sub, events)
  const deduped = dedupeEvents(aligned)
  const { expectedExpiresAt, steps } = replayStackedExpiryFromEvents(deduped)
  const canonicalMs = toMs(expectedExpiresAt)
  const actualMs = toMs(sub.expires_at)
  const classification = classifySubscription(sub, canonicalMs, actualMs, deduped, auditMs)
  const activationAtMs = deduped.length ? deduped[deduped.length - 1].atMs : null
  const mutation = proposedMutation(classification, expectedExpiresAt, sub, activationAtMs)
  const lastEvent = deduped.at(-1) ?? null
  const deltaMs = actualMs != null && canonicalMs != null ? actualMs - canonicalMs : null

  return {
    device_id: text(sub.device_id),
    device_id_masked: maskId(sub.device_id),
    subscription_id: text(sub.transaction_id) || null,
    classification,
    old_status: text(sub.status) || null,
    old_expires_at: iso(sub.expires_at),
    canonical_expires_at: expectedExpiresAt,
    admin_revoked_at: iso(sub.admin_revoked_at),
    credit_events: deduped.length,
    replay_steps: steps,
    last_package_duration_days: lastEvent?.durationDays ?? null,
    last_plan_ref: lastEvent?.ref ?? null,
    activation_at: lastEvent ? new Date(lastEvent.atMs).toISOString() : null,
    delta_ms: deltaMs,
    delta_days: deltaMs != null ? Math.round((deltaMs / DAY_MS) * 100) / 100 : null,
    active_as_of_audit:
      text(sub.status).toLowerCase() === 'active' &&
      sub.admin_revoked_at == null &&
      actualMs != null &&
      actualMs > auditMs,
    canonical_active_as_of_audit:
      canonicalMs != null && canonicalMs > auditMs && sub.admin_revoked_at == null,
    final_entitlement_as_of_audit:
      canonicalMs != null && canonicalMs > auditMs
        ? 'ACTIVE'
        : sub.admin_revoked_at
          ? 'REVOKED'
          : 'EXPIRED',
    mutation,
    evidence: {
      events: deduped.map((e) => ({
        ref: e.ref,
        kind: e.kind,
        duration_days: e.durationDays,
        at: new Date(e.atMs).toISOString(),
        credit_aligned_to_started_at: e.credit_aligned_to_started_at === true || undefined,
      })),
    },
  }
}

async function loadPlansCatalog(pool) {
  const { rows } = await pool.query(
    `SELECT id, name, price, duration_days, is_active
     FROM plans
     WHERE deleted_at IS NULL
     ORDER BY price ASC, duration_days ASC`,
  )
  const { rows: snapDurations } = await pool.query(
    `SELECT DISTINCT COALESCE(NULLIF(t.plan_duration_days, 0), p.duration_days)::int AS duration_days,
            COUNT(*)::int AS txn_count
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE t.status = 'completed'
       AND COALESCE(NULLIF(t.plan_duration_days, 0), p.duration_days) IS NOT NULL
     GROUP BY 1
     ORDER BY 1 ASC`,
  )
  return {
    live_plans: rows.map((p) => ({
      id: p.id,
      name: p.name,
      price: Number(p.price),
      duration_days: Number(p.duration_days),
      is_active: p.is_active === true,
    })),
    historical_snapshot_durations: snapDurations.map((r) => ({
      duration_days: Number(r.duration_days),
      completed_txn_count: Number(r.txn_count),
    })),
  }
}

/**
 * Full read-only audit of every device_subscriptions row.
 */
export async function auditHistoricalEntitlementCorrection({
  auditMs = AUDIT_REFERENCE_MS,
  deviceId = null,
} = {}) {
  const pool = requirePool()
  const params = []
  let deviceClause = ''
  if (deviceId) {
    params.push(text(deviceId))
    deviceClause = `WHERE ds.device_id = $${params.length}`
  }

  const [{ rows: subs }, { rows: txnCountRow }, plans] = await Promise.all([
    pool.query(
      `SELECT ds.*
       FROM device_subscriptions ds
       ${deviceClause}
       ORDER BY ds.expires_at DESC NULLS LAST, ds.device_id ASC`,
      params,
    ),
    pool.query(`SELECT COUNT(*)::int AS n FROM transactions WHERE status = 'completed'`),
    loadPlansCatalog(pool),
  ])

  const linkedOrderByDevice = new Map(
    subs
      .map((sub) => [text(sub.device_id), text(sub.transaction_id)])
      .filter(([id, orderId]) => id && orderId && !orderId.includes(':')),
  )
  const eventsByDevice = await loadCreditEventsForDevices(
    pool,
    subs.map((s) => s.device_id),
    linkedOrderByDevice,
  )

  const rows = subs.map((sub) =>
    buildAuditRow(sub, eventsByDevice.get(text(sub.device_id)) ?? [], auditMs),
  )

  const summary = {
    total_subscriptions_audited: rows.length,
    total_transactions_examined: Number(txnCountRow[0]?.n) || 0,
    correct: 0,
    expired: 0,
    over_credited: 0,
    under_credited: 0,
    duplicate_stacked: 0,
    revoked: 0,
    transferred: 0,
    ambiguous: 0,
    repair_candidates: 0,
  }
  for (const row of rows) {
    switch (row.classification) {
      case CLASSIFICATION.CORRECT:
        summary.correct += 1
        break
      case CLASSIFICATION.EXPIRED:
        summary.expired += 1
        break
      case CLASSIFICATION.OVER_CREDITED:
        summary.over_credited += 1
        break
      case CLASSIFICATION.UNDER_CREDITED:
        summary.under_credited += 1
        break
      case CLASSIFICATION.DUPLICATE_STACKED:
        summary.duplicate_stacked += 1
        break
      case CLASSIFICATION.REVOKED:
        summary.revoked += 1
        break
      case CLASSIFICATION.TRANSFERRED:
        summary.transferred += 1
        break
      default:
        summary.ambiguous += 1
    }
    if (row.mutation) summary.repair_candidates += 1
  }

  const repairCandidates = rows.filter((r) => r.mutation)
  const ambiguous = rows.filter((r) => r.classification === CLASSIFICATION.AMBIGUOUS)

  return {
    audited_at: new Date().toISOString(),
    audit_reference_eat: '2026-09-15T00:00:00+03:00',
    audit_reference_iso: new Date(auditMs).toISOString(),
    timezone: SUBSCRIPTION_TZ,
    policy: {
      replay: 'no_stack_midnight_eat',
      duration_source: 'transactions.plan_duration_days snapshot, fallback plans.duration_days',
      credit_clock:
        'completed_at → webhookAt/orderStatusPolledAt → safe updated_at → created_at; align to started_at when later',
      no_today_plus_duration: true,
      preserves_revoked: true,
      preserves_transferred: true,
      rejects_expires_before_started_at: true,
    },
    plans: plans,
    summary,
    repair_candidates: repairCandidates,
    ambiguous,
    rows,
  }
}

async function ensureBackupTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS historical_entitlement_correction_backups (
      id BIGSERIAL PRIMARY KEY,
      batch_id UUID NOT NULL,
      device_id TEXT NOT NULL,
      old_row JSONB NOT NULL,
      audit_row JSONB NOT NULL,
      old_expires_at TIMESTAMPTZ,
      new_expires_at TIMESTAMPTZ NOT NULL,
      classification TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NOT NULL DEFAULT 'historical_entitlement_correction',
      UNIQUE (batch_id, device_id)
    )
  `)
  await client.query(
    `CREATE INDEX IF NOT EXISTS historical_entitlement_correction_backups_device_idx
     ON historical_entitlement_correction_backups (device_id, applied_at DESC)`,
  )
}

/**
 * Apply evidence-backed corrections. Idempotent: skips rows already at canonical expiry.
 */
export async function applyHistoricalEntitlementCorrection({
  dryRun = true,
  confirm = false,
  appliedBy = 'historical_entitlement_correction',
  auditMs = AUDIT_REFERENCE_MS,
  deviceId = null,
  maxRepairs = 500,
} = {}) {
  const audit = await auditHistoricalEntitlementCorrection({ auditMs, deviceId })
  const candidates = audit.repair_candidates.slice(0, Math.min(500, Math.max(1, Number(maxRepairs) || 500)))

  if (dryRun || !confirm) {
    return {
      ok: true,
      dry_run: true,
      applied: false,
      batch_id: null,
      audit_summary: audit.summary,
      would_repair: candidates.length,
      repairs: candidates.map((c) => ({
        device_id_masked: c.device_id_masked,
        device_id: c.device_id,
        classification: c.classification,
        old_expires_at: c.old_expires_at,
        new_expires_at: c.mutation?.new_expires_at,
        delta_days: c.delta_days,
        action: c.mutation?.action,
      })),
      ambiguous_count: audit.summary.ambiguous,
    }
  }

  const pool = requirePool()
  const client = await pool.connect()
  const batchId = randomUUID()
  const changed = []
  const skipped = []

  try {
    await client.query('BEGIN')
    await ensureBackupTable(client)

    for (const row of candidates) {
      const d = row.device_id
      const targetIso = row.mutation.new_expires_at
      const locked = await client.query(`SELECT * FROM device_subscriptions WHERE device_id = $1 FOR UPDATE`, [d])
      const current = locked.rows[0]
      if (!current) {
        skipped.push({ device_id: d, reason: 'row_missing' })
        continue
      }
      if (current.admin_revoked_at != null) {
        skipped.push({ device_id: d, reason: 'revoked_since_audit' })
        continue
      }
      if (iso(current.expires_at) !== row.old_expires_at) {
        skipped.push({ device_id: d, reason: 'concurrent_change', now: iso(current.expires_at) })
        continue
      }
      if (Math.abs(toMs(current.expires_at) - toMs(targetIso)) <= MS_TOLERANCE) {
        skipped.push({ device_id: d, reason: 'already_canonical' })
        continue
      }

      const targetMs = toMs(targetIso)
      const startMs = toMs(current.started_at)
      if (startMs != null && targetMs != null && targetMs < startMs - MS_TOLERANCE) {
        skipped.push({
          device_id: d,
          reason: 'rejected_expires_before_started_at',
          started_at: iso(current.started_at),
          proposed: targetIso,
        })
        continue
      }

      await client.query(
        `INSERT INTO historical_entitlement_correction_backups
           (batch_id, device_id, old_row, audit_row, old_expires_at, new_expires_at, classification, applied_by)
         VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::timestamptz, $6::timestamptz, $7, $8)`,
        [
          batchId,
          d,
          JSON.stringify(current),
          JSON.stringify(row),
          row.old_expires_at,
          targetIso,
          row.classification,
          text(appliedBy),
        ],
      )

      const updated = await client.query(
        `UPDATE device_subscriptions
         SET expires_at = $2::timestamptz,
             updated_at = now()
         WHERE device_id = $1
           AND expires_at = $3::timestamptz
           AND admin_revoked_at IS NULL
         RETURNING device_id, status, expires_at, transaction_id`,
        [d, targetIso, row.old_expires_at],
      )
      if (updated.rowCount !== 1) {
        throw new Error(`Compare-and-swap failed for ${d}`)
      }

      changed.push({
        device_id: d,
        device_id_masked: row.device_id_masked,
        classification: row.classification,
        old_expires_at: row.old_expires_at,
        new_expires_at: targetIso,
        delta_days: row.delta_days,
        action: row.mutation.action,
        final_entitlement_as_of_audit: row.final_entitlement_as_of_audit,
      })
    }

    await client.query('COMMIT')
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {})
    throw e
  } finally {
    client.release()
  }

  for (const row of changed) {
    invalidateSubscriptionAccessCache(row.device_id)
    clearVerifyAccessInflightForDevice(row.device_id)
    deviceSubscriptionBus.emit('update', {
      deviceId: row.device_id,
      reason: 'historical_entitlement_corrected',
    })
  }

  const postAudit = await auditHistoricalEntitlementCorrection({ auditMs, deviceId })

  return {
    ok: true,
    dry_run: false,
    applied: true,
    batch_id: batchId,
    backup_table: 'historical_entitlement_correction_backups',
    repaired_count: changed.length,
    skipped_count: skipped.length,
    repairs: changed,
    skipped,
    pre_audit_summary: audit.summary,
    post_audit_summary: postAudit.summary,
    remaining_repair_candidates: postAudit.summary.repair_candidates,
  }
}
