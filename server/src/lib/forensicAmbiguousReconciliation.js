/**
 * Second-stage forensic reconciliation for NEEDS_MANUAL_REVIEW subscriptions.
 * Exhaustive evidence search; mutate only with strong/medium confidence.
 * Reference: 2026-09-15 00:00 Africa/Dar_es_Salaam.
 */
import { randomUUID } from 'node:crypto'
import { getPool } from '../db/pool.js'
import { replayStackedExpiryFromEvents } from './subscriptionExpiryAudit.js'
import {
  AUDIT_REFERENCE_MS,
  AUDIT_REFERENCE_ISO,
} from './historicalEntitlementCorrection.js'
import { SUBSCRIPTION_TZ } from './subscriptionStacking.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'
import { clearVerifyAccessInflightForDevice } from './verifyAccessSingleflight.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'

const MS_TOLERANCE = 2 * 60 * 1000
const DAY_MS = 86_400_000

export const FORENSIC_OUTCOME = Object.freeze({
  PROVEN_EXPIRED: 'PROVEN_EXPIRED',
  PROVEN_ACTIVE: 'PROVEN_ACTIVE',
  OVER_CREDITED_BUT_STILL_ACTIVE: 'OVER_CREDITED_BUT_STILL_ACTIVE',
  UNDER_CREDITED: 'UNDER_CREDITED',
  LEGITIMATELY_REVOKED_OR_TRANSFERRED: 'LEGITIMATELY_REVOKED_OR_TRANSFERRED',
  NO_RELIABLE_EVIDENCE: 'NO_RELIABLE_EVIDENCE',
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

function parseGrantId(txnId) {
  const m = /^manual_grant:(\d+)$/i.exec(text(txnId))
  return m ? Number(m[1]) : null
}

function isAdminManualPlaceholder(txnId) {
  return text(txnId).toLowerCase().startsWith('admin_manual:')
}

function isOsmOrder(txnId) {
  const t = text(txnId)
  return t.startsWith('osm_') || t.startsWith('osm_sp_') || t.startsWith('osm_ap_')
}

/**
 * Load all NEEDS_MANUAL_REVIEW candidates (no credit events on owning device).
 */
async function loadAmbiguousSubscriptions(pool, { deviceId = null } = {}) {
  const params = []
  let clause = `WHERE ds.admin_revoked_at IS NULL`
  // Ambiguous = no completed txn on device AND no undeleted grant on device,
  // OR transaction_id points to missing/deleted evidence.
  // Prefer explicit list from prior audit pattern: credit_events empty.
  if (deviceId) {
    params.push(text(deviceId))
    clause += ` AND ds.device_id = $${params.length}`
  }
  const { rows } = await pool.query(
    `SELECT ds.*
     FROM device_subscriptions ds
     ${clause}
     ORDER BY ds.expires_at DESC NULLS LAST`,
    params,
  )
  return rows
}

async function loadForensicEvidenceBundle(pool, subs) {
  const deviceIds = [...new Set(subs.map((s) => text(s.device_id)).filter(Boolean))]
  const txnIds = [...new Set(subs.map((s) => text(s.transaction_id)).filter(Boolean))]
  const grantIds = [
    ...new Set(txnIds.map(parseGrantId).filter((n) => Number.isFinite(n) && n >= 1)),
  ]
  const orderIds = txnIds.filter((id) => isOsmOrder(id) || (!id.includes(':') && id.length > 8))
  const fpHashes = [
    ...new Set(subs.map((s) => text(s.fingerprint_hash)).filter(Boolean)),
  ]

  const [
    txnsByDevice,
    txnsByOrder,
    grantsById,
    grantsByDevice,
    transfers,
    phones,
    webhooks,
    reconcile,
  ] = await Promise.all([
    deviceIds.length
      ? pool.query(
          `SELECT t.order_id, t.device_id, t.phone, t.plan_id, t.amount, t.currency, t.status,
                  t.created_at, t.completed_at, t.updated_at, t.external_id, t.raw_payload,
                  COALESCE(NULLIF(t.plan_duration_days, 0), p.duration_days) AS duration_days,
                  p.name AS plan_name
           FROM transactions t
           LEFT JOIN plans p ON p.id = t.plan_id
           WHERE t.device_id = ANY($1::text[])
           ORDER BY COALESCE(t.completed_at, t.created_at) ASC`,
          [deviceIds],
        )
      : { rows: [] },
    orderIds.length
      ? pool.query(
          `SELECT t.order_id, t.device_id, t.phone, t.plan_id, t.amount, t.currency, t.status,
                  t.created_at, t.completed_at, t.updated_at, t.external_id, t.raw_payload,
                  COALESCE(NULLIF(t.plan_duration_days, 0), p.duration_days) AS duration_days,
                  p.name AS plan_name
           FROM transactions t
           LEFT JOIN plans p ON p.id = t.plan_id
           WHERE t.order_id = ANY($1::text[])`,
          [orderIds],
        )
      : { rows: [] },
    grantIds.length
      ? pool.query(
          `SELECT g.*, p.name AS plan_name
           FROM manual_subscription_grants g
           LEFT JOIN plans p ON p.id = g.plan_id
           WHERE g.id = ANY($1::bigint[])`,
          [grantIds],
        )
      : { rows: [] },
    deviceIds.length
      ? pool.query(
          `SELECT g.*, p.name AS plan_name
           FROM manual_subscription_grants g
           LEFT JOIN plans p ON p.id = g.plan_id
           WHERE g.device_id = ANY($1::text[])
           ORDER BY COALESCE(g.started_at_custom, g.created_at) ASC`,
          [deviceIds],
        )
      : { rows: [] },
    deviceIds.length
      ? pool.query(
          `SELECT id, source_device_id, target_device_id, status, reason, created_at, completed_at
           FROM device_transfers
           WHERE source_device_id = ANY($1::text[]) OR target_device_id = ANY($1::text[])
           ORDER BY COALESCE(completed_at, created_at) ASC`,
          [deviceIds],
        )
      : { rows: [] },
    deviceIds.length
      ? pool.query(
          `SELECT DISTINCT ON (device_id) device_id, phone
           FROM (
             SELECT device_id::text AS device_id, phone FROM transactions
             WHERE device_id = ANY($1::text[]) AND phone IS NOT NULL AND trim(phone) <> ''
             UNION ALL
             SELECT device_id::text, phone_number FROM device_intelligence_registry
             WHERE device_id = ANY($1::text[]) AND phone_number IS NOT NULL AND trim(phone_number) <> ''
           ) x
           ORDER BY device_id`,
          [deviceIds],
        ).catch(() => ({ rows: [] }))
      : { rows: [] },
    orderIds.length
      ? pool.query(
          `SELECT id, merchant_order_id, provider_order_id, processing_status, received_at, processed_at
           FROM sonicpesa_webhook_inbox
           WHERE merchant_order_id = ANY($1::text[]) OR provider_order_id = ANY($1::text[])
           ORDER BY received_at DESC
           LIMIT 500`,
          [orderIds],
        ).catch(() => ({ rows: [] }))
      : { rows: [] },
    orderIds.length
      ? pool.query(
          `SELECT order_id, device_id, status, completed_at, created_at
           FROM sonicpesa_payment_reconciliation_queue
           WHERE order_id = ANY($1::text[])
           LIMIT 500`,
          [orderIds],
        ).catch(() => ({ rows: [] }))
      : { rows: [] },
  ])

  // Phone-linked completed payments (strong only when unique)
  const phoneList = [...new Set(phones.rows.map((r) => text(r.phone)).filter(Boolean))]
  let phoneTxns = { rows: [] }
  if (phoneList.length) {
    phoneTxns = await pool.query(
      `SELECT t.order_id, t.device_id, t.phone, t.plan_id, t.amount, t.currency, t.status,
              t.created_at, t.completed_at, t.updated_at, t.external_id,
              COALESCE(NULLIF(t.plan_duration_days, 0), p.duration_days) AS duration_days,
              p.name AS plan_name
       FROM transactions t
       LEFT JOIN plans p ON p.id = t.plan_id
       WHERE t.phone = ANY($1::text[])
         AND t.status = 'completed'
       ORDER BY COALESCE(t.completed_at, t.created_at) ASC`,
      [phoneList],
    )
  }

  // Transfer sibling completed payments
  const siblingDevices = new Set()
  for (const tr of transfers.rows) {
    if (text(tr.status) !== 'completed') continue
    siblingDevices.add(text(tr.source_device_id))
    siblingDevices.add(text(tr.target_device_id))
  }
  for (const d of deviceIds) siblingDevices.delete(d)
  let siblingTxns = { rows: [] }
  if (siblingDevices.size) {
    siblingTxns = await pool.query(
      `SELECT t.order_id, t.device_id, t.phone, t.plan_id, t.amount, t.currency, t.status,
              t.created_at, t.completed_at, t.updated_at,
              COALESCE(NULLIF(t.plan_duration_days, 0), p.duration_days) AS duration_days,
              p.name AS plan_name
       FROM transactions t
       LEFT JOIN plans p ON p.id = t.plan_id
       WHERE t.device_id = ANY($1::text[])
         AND t.status = 'completed'
       ORDER BY COALESCE(t.completed_at, t.created_at) ASC`,
      [[...siblingDevices]],
    )
  }

  return {
    txnsByDevice: txnsByDevice.rows,
    txnsByOrder: txnsByOrder.rows,
    grantsById: grantsById.rows,
    grantsByDevice: grantsByDevice.rows,
    transfers: transfers.rows,
    phones: phones.rows,
    webhooks: webhooks.rows,
    reconcile: reconcile.rows,
    phoneTxns: phoneTxns.rows,
    siblingTxns: siblingTxns.rows,
    fingerprintHashes: fpHashes,
  }
}

function txnToEvent(row, confidence, matchReason) {
  const days = Math.trunc(Number(row.duration_days))
  const at = toMs(row.completed_at) ?? toMs(row.created_at)
  if (!Number.isFinite(days) || days < 1 || at == null) return null
  if (text(row.status) !== 'completed') return null
  return {
    atMs: at,
    durationDays: days,
    kind: 'payment',
    ref: text(row.order_id),
    confidence,
    match_reason: matchReason,
    plan_name: row.plan_name ?? null,
    amount: row.amount != null ? Number(row.amount) : null,
    phone: text(row.phone) || null,
    txn_device_id: text(row.device_id) || null,
  }
}

function grantToEvent(row, confidence, matchReason) {
  const days = Math.trunc(Number(row.duration_days))
  const at = toMs(row.started_at_custom) ?? toMs(row.created_at)
  if (!Number.isFinite(days) || days < 1 || at == null) return null
  const absoluteMs = row.custom_expiry === true ? toMs(row.expires_at_custom) : null
  if (row.custom_expiry === true && absoluteMs == null) return null
  return {
    atMs: at,
    durationDays: days,
    kind: row.custom_expiry === true ? 'manual_grant_custom' : 'manual_grant',
    ref: `manual_grant:${row.id}`,
    absoluteExpiresAtMs: absoluteMs ?? undefined,
    confidence,
    match_reason: matchReason,
    plan_name: row.plan_name ?? null,
    deleted: row.deleted_at != null,
  }
}

function collectEvidenceForSub(sub, bundle) {
  const deviceId = text(sub.device_id)
  const txnId = text(sub.transaction_id)
  const evidence = {
    matches: [],
    events: [],
    transfers: [],
    webhooks: [],
    reconcile: [],
    phones: [],
    notes: [],
  }

  const phone = text(bundle.phones.find((p) => text(p.device_id) === deviceId)?.phone)
  if (phone) evidence.phones.push(phone)

  evidence.transfers = bundle.transfers.filter(
    (t) => text(t.source_device_id) === deviceId || text(t.target_device_id) === deviceId,
  )

  // 1) Exact order_id
  if (txnId) {
    for (const t of bundle.txnsByOrder) {
      if (text(t.order_id) === txnId) {
        const ev = txnToEvent(t, 'STRONG', 'exact_order_id')
        if (ev) {
          evidence.events.push(ev)
          evidence.matches.push({ type: 'transaction', order_id: t.order_id, status: t.status, confidence: 'STRONG' })
        } else {
          evidence.matches.push({
            type: 'transaction_non_completed',
            order_id: t.order_id,
            status: t.status,
            confidence: 'WEAK',
          })
          evidence.notes.push(`order ${t.order_id} found but status=${t.status}`)
        }
      }
    }
    for (const w of bundle.webhooks) {
      if (text(w.merchant_order_id) === txnId || text(w.provider_order_id) === txnId) {
        evidence.webhooks.push(w)
      }
    }
    for (const q of bundle.reconcile) {
      if (text(q.order_id) === txnId) evidence.reconcile.push(q)
    }
  }

  // 2) Grant by id (including soft-deleted)
  const gid = parseGrantId(txnId)
  if (gid != null) {
    for (const g of bundle.grantsById) {
      if (Number(g.id) === gid) {
        const ev = grantToEvent(g, 'STRONG', g.deleted_at ? 'exact_grant_id_including_deleted' : 'exact_grant_id')
        if (ev) {
          evidence.events.push(ev)
          evidence.matches.push({
            type: 'grant',
            grant_id: g.id,
            deleted: g.deleted_at != null,
            confidence: 'STRONG',
          })
        }
      }
    }
  }

  // 3) Device completed payments
  for (const t of bundle.txnsByDevice) {
    if (text(t.device_id) !== deviceId || text(t.status) !== 'completed') continue
    if (evidence.events.some((e) => e.ref === text(t.order_id))) continue
    const ev = txnToEvent(t, 'STRONG', 'device_completed_payment')
    if (ev) {
      evidence.events.push(ev)
      evidence.matches.push({ type: 'transaction', order_id: t.order_id, confidence: 'STRONG' })
    }
  }

  // 4) Device grants (undeleted preferred)
  for (const g of bundle.grantsByDevice) {
    if (text(g.device_id) !== deviceId) continue
    if (evidence.events.some((e) => e.ref === `manual_grant:${g.id}`)) continue
    if (g.deleted_at != null) continue
    const ev = grantToEvent(g, 'STRONG', 'device_undeleted_grant')
    if (ev) {
      evidence.events.push(ev)
      evidence.matches.push({ type: 'grant', grant_id: g.id, confidence: 'STRONG' })
    }
  }

  // 5) Transfer sibling completed payments (MEDIUM)
  const completedTransfers = evidence.transfers.filter((t) => text(t.status) === 'completed')
  if (completedTransfers.length) {
    const siblings = new Set()
    for (const tr of completedTransfers) {
      siblings.add(text(tr.source_device_id))
      siblings.add(text(tr.target_device_id))
    }
    siblings.delete(deviceId)
    for (const t of bundle.siblingTxns) {
      if (!siblings.has(text(t.device_id))) continue
      if (evidence.events.some((e) => e.ref === text(t.order_id))) continue
      const ev = txnToEvent(t, 'MEDIUM', 'transfer_sibling_completed_payment')
      if (ev) {
        evidence.events.push(ev)
        evidence.matches.push({
          type: 'transfer_linked_payment',
          order_id: t.order_id,
          from_device: t.device_id,
          confidence: 'MEDIUM',
        })
      }
    }
  }

  // 6) Phone-linked completed payments — only if unique single device ownership chain (MEDIUM)
  // Skip for admin_manual placeholders to avoid wrongly attributing another customer's payment.
  if (phone && !isAdminManualPlaceholder(txnId) && evidence.events.length === 0) {
    const phonePayments = bundle.phoneTxns.filter((t) => text(t.phone) === phone && text(t.status) === 'completed')
    const otherDevices = [...new Set(phonePayments.map((t) => text(t.device_id)).filter((d) => d && d !== deviceId))]
    if (phonePayments.length === 1 && otherDevices.length === 0) {
      const t = phonePayments[0]
      const ev = txnToEvent(t, 'MEDIUM', 'unique_phone_completed_payment')
      if (ev) {
        evidence.events.push(ev)
        evidence.matches.push({ type: 'phone_payment', order_id: t.order_id, confidence: 'MEDIUM' })
      }
    } else if (phonePayments.length > 1) {
      evidence.notes.push(
        `phone ${maskId(phone)} has ${phonePayments.length} completed payments across ${1 + otherDevices.length} devices — not auto-attributed`,
      )
    }
  }

  // Dedupe events
  const seen = new Set()
  evidence.events = evidence.events
    .sort((a, b) => a.atMs - b.atMs || a.ref.localeCompare(b.ref))
    .filter((e) => {
      const k = `${e.kind}:${e.ref}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

  return evidence
}

function classifyForensic(sub, evidence, auditMs) {
  const txnId = text(sub.transaction_id)
  const actualMs = toMs(sub.expires_at)
  const status = text(sub.status).toLowerCase()

  if (sub.admin_revoked_at != null) {
    return {
      outcome: FORENSIC_OUTCOME.LEGITIMATELY_REVOKED_OR_TRANSFERRED,
      confidence: 'STRONG',
      reason: 'admin_revoked_at set',
      canonical_expires_at: iso(sub.expires_at),
      mutation: null,
    }
  }
  if (isSpecialTxn(txnId)) {
    return {
      outcome: FORENSIC_OUTCOME.LEGITIMATELY_REVOKED_OR_TRANSFERRED,
      confidence: 'STRONG',
      reason: `transaction_id prefix indicates transfer/recovery (${txnId.split(':')[0]})`,
      canonical_expires_at: iso(sub.expires_at),
      mutation: null,
    }
  }

  const strongOrMedium = evidence.events.filter((e) => e.confidence === 'STRONG' || e.confidence === 'MEDIUM')
  if (!strongOrMedium.length) {
    // Admin-manual placeholder / pending with past expiry and zero payments:
    // Proven that there is no qualifying entitlement. Already inactive for access.
    if (isAdminManualPlaceholder(txnId) || status === 'pending') {
      if (actualMs != null && actualMs <= auditMs) {
        return {
          outcome: FORENSIC_OUTCOME.PROVEN_EXPIRED,
          confidence: 'STRONG',
          reason:
            isAdminManualPlaceholder(txnId)
              ? 'admin_manual placeholder row with no qualifying payment/grant; expires_at already past reference date (access already denied)'
              : 'pending subscription with no qualifying payment/grant; expires_at already past reference date',
          canonical_expires_at: iso(sub.expires_at),
          // No mutation needed — already expired/inactive for access. Record as resolved.
          mutation: null,
          already_inactive: true,
        }
      }
    }
    // status=active but past expires_at and no evidence
    if (status === 'active' && actualMs != null && actualMs <= auditMs) {
      return {
        outcome: FORENSIC_OUTCOME.PROVEN_EXPIRED,
        confidence: 'MEDIUM',
        reason:
          'status=active but expires_at already past reference date and no reconstructable payment/grant; entitlement already inactive for access',
        canonical_expires_at: iso(sub.expires_at),
        mutation: null,
        already_inactive: true,
      }
    }
    return {
      outcome: FORENSIC_OUTCOME.NO_RELIABLE_EVIDENCE,
      confidence: 'NONE',
      reason: evidence.notes.join('; ') || 'no strong/medium payment, grant, order, or transfer-linked evidence',
      canonical_expires_at: null,
      mutation: null,
    }
  }

  const replayEvents = strongOrMedium.map((e) => ({
    atMs: e.atMs,
    durationDays: e.durationDays,
    kind: e.kind,
    ref: e.ref,
    absoluteExpiresAtMs: e.absoluteExpiresAtMs,
  }))
  const { expectedExpiresAt, steps } = replayStackedExpiryFromEvents(replayEvents)
  const canonicalMs = toMs(expectedExpiresAt)
  if (canonicalMs == null) {
    return {
      outcome: FORENSIC_OUTCOME.NO_RELIABLE_EVIDENCE,
      confidence: 'NONE',
      reason: 'replay failed despite events',
      canonical_expires_at: null,
      mutation: null,
      replay_steps: steps,
    }
  }

  const deltaMs = actualMs != null ? actualMs - canonicalMs : null
  const stillActive = canonicalMs > auditMs
  const conf = strongOrMedium.every((e) => e.confidence === 'STRONG') ? 'STRONG' : 'MEDIUM'

  let outcome
  if (Math.abs(deltaMs ?? Infinity) <= MS_TOLERANCE) {
    outcome = stillActive ? FORENSIC_OUTCOME.PROVEN_ACTIVE : FORENSIC_OUTCOME.PROVEN_EXPIRED
  } else if (deltaMs > MS_TOLERANCE) {
    outcome = stillActive
      ? FORENSIC_OUTCOME.OVER_CREDITED_BUT_STILL_ACTIVE
      : FORENSIC_OUTCOME.PROVEN_EXPIRED
  } else {
    outcome = FORENSIC_OUTCOME.UNDER_CREDITED
  }

  let mutation = null
  if (actualMs == null || Math.abs(actualMs - canonicalMs) > MS_TOLERANCE) {
    mutation = {
      old_status: status,
      new_status: status === 'pending' && stillActive ? 'active' : status,
      old_expires_at: iso(sub.expires_at),
      new_expires_at: expectedExpiresAt,
      action:
        outcome === FORENSIC_OUTCOME.UNDER_CREDITED
          ? 'restore_canonical_expiry'
          : outcome === FORENSIC_OUTCOME.PROVEN_EXPIRED
            ? 'correct_to_expired_canonical'
            : 'align_to_canonical_expiry',
    }
  }

  return {
    outcome,
    confidence: conf,
    reason: `reconstructed from ${strongOrMedium.length} credit event(s) via ${[
      ...new Set(strongOrMedium.map((e) => e.match_reason)),
    ].join(', ')}; canonical ${expectedExpiresAt} vs current ${iso(sub.expires_at)}; as_of_15_sep=${stillActive ? 'ACTIVE' : 'EXPIRED'}`,
    canonical_expires_at: expectedExpiresAt,
    replay_steps: steps,
    mutation,
    already_inactive: !stillActive && (actualMs == null || actualMs <= auditMs),
  }
}

function buildRow(sub, evidence, classification, auditMs) {
  return {
    device_id: text(sub.device_id),
    device_id_masked: maskId(sub.device_id),
    subscription_id: text(sub.transaction_id) || null,
    phone: evidence.phones[0] || null,
    current_package: evidence.events.at(-1)?.plan_name || null,
    current_status: text(sub.status),
    current_expires_at: iso(sub.expires_at),
    payment_evidence: evidence.matches,
    events: evidence.events.map((e) => ({
      ref: e.ref,
      kind: e.kind,
      duration_days: e.durationDays,
      at: new Date(e.atMs).toISOString(),
      confidence: e.confidence,
      match_reason: e.match_reason,
    })),
    transfer_evidence: evidence.transfers.map((t) => ({
      id: t.id,
      status: t.status,
      source: maskId(t.source_device_id),
      target: maskId(t.target_device_id),
      at: iso(t.completed_at || t.created_at),
    })),
    webhook_evidence: evidence.webhooks.slice(0, 5).map((w) => ({
      id: w.id,
      status: w.processing_status,
      merchant_order_id: w.merchant_order_id,
    })),
    reconcile_evidence: evidence.reconcile.slice(0, 5),
    historical_plan_duration_days: evidence.events.map((e) => e.durationDays),
    activation_timestamp: evidence.events[0] ? new Date(evidence.events[0].atMs).toISOString() : null,
    canonical_expires_at: classification.canonical_expires_at,
    reference_date: '2026-09-15T00:00:00+03:00',
    state_on_15_sep:
      classification.canonical_expires_at && toMs(classification.canonical_expires_at) > auditMs
        ? 'ACTIVE'
        : classification.outcome === FORENSIC_OUTCOME.NO_RELIABLE_EVIDENCE
          ? 'UNKNOWN'
          : 'EXPIRED',
    outcome: classification.outcome,
    confidence: classification.confidence,
    reason: classification.reason,
    notes: evidence.notes,
    mutation: classification.mutation,
    already_inactive: classification.already_inactive === true,
    replay_steps: classification.replay_steps || null,
  }
}

/**
 * Forensic dry-run for ambiguous / NEEDS_MANUAL_REVIEW rows.
 * If deviceId omitted, audits rows that first-stage marked ambiguous (0 device credit events).
 */
export async function auditForensicAmbiguousReconciliation({
  auditMs = AUDIT_REFERENCE_MS,
  deviceId = null,
  onlyAmbiguous = true,
} = {}) {
  const pool = requirePool()
  const allSubs = await loadAmbiguousSubscriptions(pool, { deviceId })

  // First-stage filter: no credit events on owning device
  let candidates = allSubs
  if (onlyAmbiguous) {
    const { loadCreditEventsForDevices } = await import('./subscriptionExpiryAudit.js')
    const linked = new Map(
      allSubs
        .map((s) => [text(s.device_id), text(s.transaction_id)])
        .filter(([id, oid]) => id && oid && !oid.includes(':')),
    )
    const eventsBy = await loadCreditEventsForDevices(
      pool,
      allSubs.map((s) => s.device_id),
      linked,
    )
    candidates = allSubs.filter((s) => {
      if (isSpecialTxn(s.transaction_id)) return false
      if (s.admin_revoked_at != null) return false
      return (eventsBy.get(text(s.device_id)) ?? []).length === 0
    })
  }

  const bundle = await loadForensicEvidenceBundle(pool, candidates)
  const rows = []
  for (const sub of candidates) {
    const evidence = collectEvidenceForSub(sub, bundle)
    const classification = classifyForensic(sub, evidence, auditMs)
    rows.push(buildRow(sub, evidence, classification, auditMs))
  }

  const summary = {
    investigated: rows.length,
    proven_expired: 0,
    proven_active: 0,
    over_credited_but_still_active: 0,
    under_credited: 0,
    revoked_or_transferred: 0,
    no_reliable_evidence: 0,
    mutations_proposed: 0,
    already_inactive_resolved: 0,
  }
  for (const r of rows) {
    switch (r.outcome) {
      case FORENSIC_OUTCOME.PROVEN_EXPIRED:
        summary.proven_expired += 1
        break
      case FORENSIC_OUTCOME.PROVEN_ACTIVE:
        summary.proven_active += 1
        break
      case FORENSIC_OUTCOME.OVER_CREDITED_BUT_STILL_ACTIVE:
        summary.over_credited_but_still_active += 1
        break
      case FORENSIC_OUTCOME.UNDER_CREDITED:
        summary.under_credited += 1
        break
      case FORENSIC_OUTCOME.LEGITIMATELY_REVOKED_OR_TRANSFERRED:
        summary.revoked_or_transferred += 1
        break
      default:
        summary.no_reliable_evidence += 1
    }
    if (r.mutation) summary.mutations_proposed += 1
    if (r.already_inactive && r.outcome !== FORENSIC_OUTCOME.NO_RELIABLE_EVIDENCE) {
      summary.already_inactive_resolved += 1
    }
  }

  const durations = new Set()
  for (const r of rows) for (const d of r.historical_plan_duration_days || []) durations.add(d)

  return {
    audited_at: new Date().toISOString(),
    audit_reference_iso: AUDIT_REFERENCE_ISO,
    timezone: SUBSCRIPTION_TZ,
    summary,
    historical_durations_discovered: [...durations].sort((a, b) => a - b),
    evidence_sources_inspected: {
      transactions_by_device: bundle.txnsByDevice.length,
      transactions_by_order: bundle.txnsByOrder.length,
      grants_by_id: bundle.grantsById.length,
      grants_by_device: bundle.grantsByDevice.length,
      transfers: bundle.transfers.length,
      phone_payments: bundle.phoneTxns.length,
      sibling_payments: bundle.siblingTxns.length,
      webhooks: bundle.webhooks.length,
      reconcile_queue: bundle.reconcile.length,
    },
    repair_candidates: rows.filter((r) => r.mutation),
    resolved_without_mutation: rows.filter(
      (r) => !r.mutation && r.outcome !== FORENSIC_OUTCOME.NO_RELIABLE_EVIDENCE,
    ),
    remaining_manual_review: rows.filter((r) => r.outcome === FORENSIC_OUTCOME.NO_RELIABLE_EVIDENCE),
    rows,
  }
}

async function ensureBackupTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS forensic_ambiguous_reconciliation_backups (
      id BIGSERIAL PRIMARY KEY,
      batch_id UUID NOT NULL,
      device_id TEXT NOT NULL,
      old_row JSONB NOT NULL,
      forensic_row JSONB NOT NULL,
      old_expires_at TIMESTAMPTZ,
      new_expires_at TIMESTAMPTZ NOT NULL,
      outcome TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      applied_by TEXT NOT NULL DEFAULT 'forensic_ambiguous_reconciliation',
      UNIQUE (batch_id, device_id)
    )
  `)
}

export async function applyForensicAmbiguousReconciliation({
  dryRun = true,
  confirm = false,
  appliedBy = 'forensic_ambiguous_reconciliation',
  auditMs = AUDIT_REFERENCE_MS,
  maxRepairs = 200,
} = {}) {
  const audit = await auditForensicAmbiguousReconciliation({ auditMs })
  const candidates = audit.repair_candidates.slice(0, Math.min(200, Math.max(1, Number(maxRepairs) || 200)))

  if (dryRun || !confirm) {
    return {
      ok: true,
      dry_run: true,
      applied: false,
      summary: audit.summary,
      would_repair: candidates.length,
      repairs: candidates,
      remaining_manual_review: audit.summary.no_reliable_evidence,
      resolved_without_mutation: audit.summary.already_inactive_resolved,
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
        skipped.push({ device_id: d, reason: 'revoked' })
        continue
      }
      if (iso(current.expires_at) !== row.current_expires_at) {
        skipped.push({ device_id: d, reason: 'concurrent_change' })
        continue
      }
      if (Math.abs(toMs(current.expires_at) - toMs(targetIso)) <= MS_TOLERANCE) {
        skipped.push({ device_id: d, reason: 'already_canonical' })
        continue
      }

      await client.query(
        `INSERT INTO forensic_ambiguous_reconciliation_backups
           (batch_id, device_id, old_row, forensic_row, old_expires_at, new_expires_at, outcome, applied_by)
         VALUES ($1::uuid, $2, $3::jsonb, $4::jsonb, $5::timestamptz, $6::timestamptz, $7, $8)`,
        [
          batchId,
          d,
          JSON.stringify(current),
          JSON.stringify(row),
          row.current_expires_at,
          targetIso,
          row.outcome,
          text(appliedBy),
        ],
      )

      const nextStatus =
        row.mutation.new_status === 'active' || row.mutation.new_status === 'pending'
          ? row.mutation.new_status
          : text(current.status)

      const updated = await client.query(
        `UPDATE device_subscriptions
         SET expires_at = $2::timestamptz,
             status = $4,
             updated_at = now()
         WHERE device_id = $1
           AND expires_at = $3::timestamptz
           AND admin_revoked_at IS NULL
         RETURNING device_id, status, expires_at`,
        [d, targetIso, row.current_expires_at, nextStatus],
      )
      if (updated.rowCount !== 1) throw new Error(`CAS failed for ${d}`)
      changed.push({
        device_id: d,
        device_id_masked: row.device_id_masked,
        outcome: row.outcome,
        old_expires_at: row.current_expires_at,
        new_expires_at: targetIso,
        reason: row.reason,
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
      reason: 'forensic_ambiguous_reconciled',
    })
  }

  const post = await auditForensicAmbiguousReconciliation({ auditMs })
  return {
    ok: true,
    dry_run: false,
    applied: true,
    batch_id: batchId,
    backup_table: 'forensic_ambiguous_reconciliation_backups',
    repaired_count: changed.length,
    skipped_count: skipped.length,
    repairs: changed,
    skipped,
    pre_summary: audit.summary,
    post_summary: post.summary,
  }
}
