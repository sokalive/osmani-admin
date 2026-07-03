/**
 * Full production device investigation — read-only PostgreSQL aggregates.
 */
import { getPool } from '../db/pool.js'
import { getDeviceSubscriptionAccessState, getDeviceSubscriptionAccessStateFast } from '../billingStore.js'
import { repairFalseExpiredSubscriptions, findFalseExpiredSubscriptions } from './subscriptionFalseExpiredRepair.js'
import { invalidateSubscriptionAccessCache } from './subscriptionAccessCache.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required')
  return pool
}

function toIso(v) {
  if (v == null) return null
  if (v instanceof Date) return v.toISOString()
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? String(v) : d.toISOString()
}

async function linkedDeviceIds(pool, deviceId) {
  const ids = new Set([String(deviceId).trim()])
  const { rows: phones } = await pool.query(
    `SELECT DISTINCT phone_number_normalized AS phone
     FROM device_phone_registry WHERE device_id::text = $1 AND trim(phone_number_normalized) <> ''
     UNION
     SELECT DISTINCT regexp_replace(coalesce(phone::text,''), '[^0-9]', '', 'g')
     FROM transactions WHERE device_id::text = $1 AND trim(coalesce(phone::text,'')) <> ''
     UNION
     SELECT DISTINCT phone_number FROM device_intelligence_registry WHERE device_id::text = $1 AND trim(coalesce(phone_number,'')) <> ''`,
    [deviceId],
  )
  for (const p of phones) {
    const phone = String(p.phone ?? '').trim()
    if (phone.length < 9) continue
    const { rows: linked } = await pool.query(
      `SELECT DISTINCT device_id::text AS device_id FROM device_phone_registry WHERE phone_number_normalized = $1
       UNION SELECT DISTINCT device_id::text FROM transactions WHERE regexp_replace(coalesce(phone::text,''), '[^0-9]', '', 'g') = $1
       UNION SELECT DISTINCT device_id::text FROM device_intelligence_registry WHERE regexp_replace(coalesce(phone_number,''), '[^0-9]', '', 'g') = $1`,
      [phone],
    )
    for (const r of linked) if (r.device_id) ids.add(String(r.device_id))
  }
  const { rows: installs } = await pool.query(
    `SELECT install_instance_id FROM app_installs WHERE device_id::text = $1 AND trim(install_instance_id) <> '' LIMIT 5`,
    [deviceId],
  )
  for (const ins of installs) {
    const { rows: sibs } = await pool.query(
      `SELECT DISTINCT device_id::text AS device_id FROM app_installs WHERE install_instance_id = $1`,
      [ins.install_instance_id],
    )
    for (const r of sibs) if (r.device_id) ids.add(String(r.device_id))
  }
  return [...ids].filter(Boolean)
}

function providerFromTxn(row) {
  const oid = String(row.order_id ?? '')
  const raw = row.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}
  if (oid.startsWith('osm_sp_') || raw.sonicpesa) return 'sonicpesa'
  if (oid.startsWith('osm_ax_') || raw.auraxpay) return 'auraxpay'
  if (raw.payment_provider) return String(raw.payment_provider).toLowerCase()
  return 'zenopay'
}

function buildTimeline(events) {
  return events
    .filter((e) => e.at)
    .sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime())
}

export async function runDeviceProductionInvestigation(deviceId, pool = requirePool()) {
  const d = String(deviceId ?? '').trim()
  if (!d) throw new Error('device_id is required')

  const nowRow = await pool.query(`SELECT now() AS db_now_utc, now() AT TIME ZONE 'Africa/Nairobi' AS db_now_eat`)
  const dbNowUtc = nowRow.rows[0]?.db_now_utc
  const dbNowEat = nowRow.rows[0]?.db_now_eat

  const linkedIds = await linkedDeviceIds(pool, d)

  const { rows: subscriptions } = await pool.query(
    `SELECT * FROM device_subscriptions WHERE device_id::text = ANY($1::text[]) ORDER BY updated_at ASC`,
    [linkedIds],
  )

  const { rows: transactions } = await pool.query(
    `SELECT t.*, p.name AS plan_name, p.duration_days
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id
     WHERE t.device_id::text = ANY($1::text[])
        OR t.phone IN (SELECT DISTINCT phone FROM transactions WHERE device_id::text = ANY($1::text[]) AND phone IS NOT NULL)
     ORDER BY t.created_at ASC`,
    [linkedIds],
  )

  const { rows: securityEvents } = await pool.query(
    `SELECT id, actor, event_type, status, detail, metadata, created_at
     FROM security_events
     WHERE actor = ANY($1::text[])
        OR metadata->>'device_id' = ANY($1::text[])
        OR metadata->>'source_device_id' = ANY($1::text[])
        OR metadata->>'target_device_id' = ANY($1::text[])
     ORDER BY created_at ASC`,
    [linkedIds],
  )

  const { rows: manualGrants } = await pool.query(
    `SELECT g.*, p.name AS plan_name FROM manual_subscription_grants g
     LEFT JOIN plans p ON p.id = g.plan_id
     WHERE g.device_id::text = ANY($1::text[]) AND g.deleted_at IS NULL
     ORDER BY g.created_at ASC`,
    [linkedIds],
  )

  const { rows: transfersOut } = await pool.query(
    `SELECT dt.*, tc.code AS transfer_code FROM device_transfers dt
     LEFT JOIN transfer_codes tc ON tc.id = dt.code_id
     WHERE dt.source_device_id::text = ANY($1::text[]) ORDER BY dt.created_at ASC`,
    [linkedIds],
  )
  const { rows: transfersIn } = await pool.query(
    `SELECT dt.*, tc.code AS transfer_code FROM device_transfers dt
     LEFT JOIN transfer_codes tc ON tc.id = dt.code_id
     WHERE dt.target_device_id::text = ANY($1::text[]) ORDER BY dt.created_at ASC`,
    [linkedIds],
  )

  const { rows: smsLog } = await pool.query(
    `SELECT id, recipient, device_id, message, template_key, trigger_type, status, sms_type,
            payment_id, subscription_id, created_at
     FROM sms_send_log
     WHERE device_id::text = ANY($1::text[])
        OR recipient IN (
          SELECT DISTINCT phone::text FROM transactions WHERE device_id::text = ANY($1::text[]) AND phone IS NOT NULL
        )
     ORDER BY created_at ASC
     LIMIT 200`,
    [linkedIds],
  ).catch(() => ({ rows: [] }))

  const { rows: phoneRegistry } = await pool.query(
    `SELECT * FROM device_phone_registry WHERE device_id::text = ANY($1::text[]) ORDER BY updated_at ASC`,
    [linkedIds],
  )

  const { rows: installs } = await pool.query(
    `SELECT device_id, install_instance_id, installed_at FROM app_installs
     WHERE device_id::text = ANY($1::text[]) OR install_instance_id IN (
       SELECT install_instance_id FROM app_installs WHERE device_id::text = $2 AND trim(install_instance_id) <> ''
     ) ORDER BY installed_at ASC`,
    [linkedIds, d],
  )

  let recoveryLog = []
  try {
    const r = await pool.query(
      `SELECT * FROM subscription_recovery_log
       WHERE source_device_id::text = ANY($1::text[]) OR target_device_id::text = ANY($1::text[])
       ORDER BY created_at ASC LIMIT 100`,
      [linkedIds],
    )
    recoveryLog = r.rows
  } catch {
    recoveryLog = []
  }

  const { rows: offerRedemptions } = await pool.query(
    `SELECT code, duration_days, redeemed_at, redeemed_by_device_id, blocked, deleted_at
     FROM offer_codes
     WHERE redeemed_by_device_id::text = ANY($1::text[])
     ORDER BY redeemed_at ASC NULLS LAST`,
    [linkedIds],
  ).catch(() => ({ rows: [] }))

  const primarySub = subscriptions.find((s) => String(s.device_id) === d) || subscriptions[0] || null

  const access = await getDeviceSubscriptionAccessState(d, null).catch(() => null)
  const accessFast = await getDeviceSubscriptionAccessStateFast(d).catch(() => null)

  const completedPayments = transactions.filter((t) => String(t.status).toLowerCase() === 'completed')
  const hasCompletedPayment = completedPayments.length > 0
  const hasManualGrant = manualGrants.length > 0
  const hasRecoveryTxn = subscriptions.some((s) => String(s.transaction_id ?? '').startsWith('recovery:'))
  const hasOfferCode = subscriptions.some((s) => String(s.transaction_id ?? '').startsWith('offer_code:'))
  const hasTransferIn = transfersIn.some((t) => String(t.status).toLowerCase() === 'completed')
  const paidEntitlement = hasCompletedPayment || hasManualGrant || hasRecoveryTxn || hasOfferCode || hasTransferIn

  const expiresMs = primarySub?.expires_at ? new Date(primarySub.expires_at).getTime() : null
  const futureExpiry = expiresMs != null && expiresMs > Date.now()
  const shouldBeActive =
    futureExpiry &&
    String(primarySub?.status ?? '').toLowerCase() === 'active' &&
    primarySub?.manual_admin_blocked !== true &&
    access?.blocked_now !== true

  const falseExpiredAudit = await findFalseExpiredSubscriptions(pool)
  const isFalseExpired = falseExpiredAudit.affected.some((r) => r.device_id === d)

  const timeline = buildTimeline([
    ...transactions.map((t) => ({
      kind: 'transaction',
      at: toIso(t.created_at),
      title: `Transaction ${t.status}`,
      detail: `${providerFromTxn(t)} · ${t.order_id} · ${t.amount} TZS`,
      data: {
        order_id: t.order_id,
        provider: providerFromTxn(t),
        amount: t.amount,
        status: t.status,
        completed_at: toIso(t.status === 'completed' ? t.updated_at || t.created_at : null),
        device_id: t.device_id,
        phone: t.phone,
        webhook_hint: t.raw_payload?.webhook ?? t.raw_payload?.order_status_poll ?? null,
        reconcile_hint: t.raw_payload?.order_status_poll ?? null,
      },
    })),
    ...subscriptions.map((s) => ({
      kind: 'subscription',
      at: toIso(s.started_at || s.updated_at),
      title: `Subscription ${s.status}`,
      detail: `expires ${toIso(s.expires_at)} · txn ${s.transaction_id}`,
      data: s,
    })),
    ...securityEvents.map((e) => ({
      kind: 'security',
      at: toIso(e.created_at),
      title: e.event_type,
      detail: e.detail,
      data: e,
    })),
    ...manualGrants.map((g) => ({
      kind: 'manual_grant',
      at: toIso(g.created_at),
      title: 'Manual grant',
      detail: `${g.duration_days} days`,
      data: g,
    })),
    ...transfersOut.map((t) => ({
      kind: 'transfer_out',
      at: toIso(t.created_at),
      title: `Transfer out (${t.status})`,
      detail: `→ ${t.target_device_id}`,
      data: t,
    })),
    ...transfersIn.map((t) => ({
      kind: 'transfer_in',
      at: toIso(t.created_at),
      title: `Transfer in (${t.status})`,
      detail: `← ${t.source_device_id}`,
      data: t,
    })),
    ...recoveryLog.map((r) => ({
      kind: 'recovery_log',
      at: toIso(r.created_at),
      title: 'Recovery log',
      detail: `${r.source_device_id} → ${r.target_device_id}`,
      data: r,
    })),
    ...smsLog.map((s) => ({
      kind: 'sms',
      at: toIso(s.created_at),
      title: `SMS ${s.status}`,
      detail: `${s.sms_type || s.template_key} → ${s.recipient}`,
      data: s,
    })),
    ...offerRedemptions.map((o) => ({
      kind: 'offer_code',
      at: toIso(o.redeemed_at),
      title: 'Offer code redeemed',
      detail: o.code,
      data: o,
    })),
  ])

  const paymentVerification = completedPayments.map((t) => ({
    order_id: t.order_id,
    provider: providerFromTxn(t),
    amount: t.amount != null ? Number(t.amount) : null,
    payment_status: t.status,
    completed_at: toIso(t.updated_at || t.created_at),
    activated_at: toIso(
      subscriptions.find((s) => String(s.transaction_id) === String(t.order_id))?.started_at,
    ),
    expires_at: toIso(subscriptions.find((s) => String(s.transaction_id) === String(t.order_id))?.expires_at),
    customer_actually_paid: String(t.status).toLowerCase() === 'completed' ? 'YES' : 'NO',
    device_id: t.device_id,
    phone: t.phone,
  }))

  return {
    device_id: d,
    investigated_at: new Date().toISOString(),
    production_time_utc: toIso(dbNowUtc),
    production_time_eat: toIso(dbNowEat),
    linked_device_ids: linkedIds,
    phone_numbers: [
      ...new Set([
        ...phoneRegistry.map((p) => p.phone_number_normalized),
        ...transactions.map((t) => String(t.phone ?? '').trim()).filter(Boolean),
      ]),
    ],
    payment_verification: {
      has_completed_payment: hasCompletedPayment,
      customer_actually_paid: paidEntitlement ? 'YES' : 'NO',
      paid_via: {
        completed_payment: hasCompletedPayment,
        manual_grant: hasManualGrant,
        recovery: hasRecoveryTxn,
        offer_code: hasOfferCode,
        transfer_in: hasTransferIn,
      },
      payments: paymentVerification,
      if_no_payment: paidEntitlement
        ? null
        : 'This customer has no completed payment, manual grant, recovery, offer code, or completed transfer entitlement on linked devices.',
    },
    subscription_audit: {
      device_subscriptions: subscriptions.map((s) => ({
        device_id: s.device_id,
        status: s.status,
        expires_at: toIso(s.expires_at),
        started_at: toIso(s.started_at),
        transaction_id: s.transaction_id,
        manual_admin_blocked: s.manual_admin_blocked,
        updated_at: toIso(s.updated_at),
      })),
      should_be_active: shouldBeActive ? 'YES' : 'NO',
      is_false_expired: isFalseExpired,
      access_state: access,
      access_cache_fast: accessFast,
      expires_at: toIso(primarySub?.expires_at),
      remaining_seconds: access?.remaining_seconds ?? null,
      remaining_days: access?.remaining_days ?? null,
    },
    timeline,
    counts: {
      transactions: transactions.length,
      completed_payments: completedPayments.length,
      security_events: securityEvents.length,
      manual_grants: manualGrants.length,
      transfers_out: transfersOut.length,
      transfers_in: transfersIn.length,
      sms_events: smsLog.length,
      phone_registry_rows: phoneRegistry.length,
      install_rows: installs.length,
      recovery_log_rows: recoveryLog.length,
      offer_code_redemptions: offerRedemptions.length,
    },
    raw: {
      transactions,
      security_events: securityEvents,
      manual_grants: manualGrants,
      transfers_out: transfersOut,
      transfers_in: transfersIn,
      sms_log: smsLog,
      phone_registry: phoneRegistry,
      app_installs: installs,
      recovery_log: recoveryLog,
      offer_codes: offerRedemptions,
    },
  }
}

/** Repair false-expired for one device if eligible — never extends expires_at. */
export async function repairDeviceIfEligible(deviceId, pool = requirePool()) {
  const d = String(deviceId ?? '').trim()
  const inv = await runDeviceProductionInvestigation(d, pool)
  const audit = await findFalseExpiredSubscriptions(pool)
  const affected = audit.affected.find((r) => r.device_id === d)
  if (!affected) {
    return { device_id: d, repaired: false, reason: 'not_in_false_expired_audit', investigation: inv }
  }
  const repair = await repairFalseExpiredSubscriptions({ dryRun: false, confirm: true })
  invalidateSubscriptionAccessCache(d)
  const after = await getDeviceSubscriptionAccessState(d, null)
  return {
    device_id: d,
    repaired: true,
    repair_result: repair.repaired?.find((r) => r.device_id === d) || repair,
    access_after: after,
    investigation_summary: {
      should_be_active: inv.subscription_audit.should_be_active,
      customer_actually_paid: inv.payment_verification.customer_actually_paid,
    },
  }
}
