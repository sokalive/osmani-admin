/**
 * Read-only customer / payment investigation for admin support.
 */
import { getPool } from '../db/pool.js'
import {
  findActiveDeviceIdForPaymentPhone,
  getDeviceSubscriptionAccessState,
  normalizePhoneDigits,
  tzPhoneCanonicalSql,
} from '../billingStore.js'

function requirePool() {
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL is required.')
  return pool
}

function text(v, max = 256) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function providerFromTxn(row) {
  const raw = row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}
  const p = String(raw.payment_provider ?? raw.provider ?? '').trim().toLowerCase()
  if (p === 'sonicpesa') return 'sonicpesa'
  if (p === 'auraxpay') return 'auraxpay'
  return p || 'zenopay'
}

function providerLabel(p) {
  const k = String(p ?? '').toLowerCase()
  if (k === 'sonicpesa') return 'SonicPesa'
  if (k === 'auraxpay') return 'AuraxPay'
  if (k === 'zenopay') return 'ZenoPay'
  return k || 'ZenoPay'
}

function lastProviderResponse(row) {
  const raw = row?.raw_payload && typeof row.raw_payload === 'object' ? row.raw_payload : {}
  return (
    text(raw.provider_message ?? raw.providerMessage, 2000) ||
    text(raw.failure_reason ?? raw.error, 2000) ||
    text(raw.zeno?.message, 2000) ||
    text(raw.sonic?.message, 2000) ||
    text(raw.aurax?.message, 2000) ||
    ''
  )
}

function mapTxnRow(r) {
  const created = r.created_at instanceof Date ? r.created_at : new Date(String(r.created_at))
  const updated = r.updated_at instanceof Date ? r.updated_at : new Date(String(r.updated_at ?? r.created_at))
  const prov = providerFromTxn(r)
  return {
    order_id: String(r.order_id ?? ''),
    external_id: r.external_id != null ? String(r.external_id) : null,
    device_id: r.device_id != null ? String(r.device_id) : '',
    phone: String(r.phone ?? ''),
    phone_normalized: normalizePhoneDigits(r.phone) || null,
    plan_id: r.plan_id != null ? Number(r.plan_id) : null,
    plan_name: r.plan_name != null ? String(r.plan_name) : null,
    amount: r.amount != null ? Number(r.amount) : null,
    currency: String(r.currency ?? 'TZS'),
    status: String(r.status ?? ''),
    provider: prov,
    provider_label: providerLabel(prov),
    provider_reference: r.external_id != null ? String(r.external_id) : null,
    last_provider_response: lastProviderResponse(r),
    subscription_activated:
      r.status === 'completed' && String(r.subscription_linked ?? '') === 'true'
        ? true
        : r.status === 'completed'
          ? null
          : false,
    created_at: created instanceof Date && !Number.isNaN(created.getTime()) ? created.toISOString() : null,
    updated_at: updated instanceof Date && !Number.isNaN(updated.getTime()) ? updated.toISOString() : null,
  }
}

function mapSubRow(r, nowMs = Date.now()) {
  const exp = r.expires_at instanceof Date ? r.expires_at : new Date(String(r.expires_at))
  const expiresAt = exp instanceof Date && !Number.isNaN(exp.getTime()) ? exp.toISOString() : null
  const active = r.status === 'active' && expiresAt && new Date(expiresAt).getTime() > nowMs
  return {
    device_id: String(r.device_id ?? ''),
    status: active ? 'active' : String(r.status ?? 'expired'),
    expires_at: expiresAt,
    transaction_id: String(r.transaction_id ?? ''),
    manual_admin_blocked: Boolean(r.manual_admin_blocked),
    fingerprint_hash: r.fingerprint_hash != null ? String(r.fingerprint_hash) : null,
    started_at:
      r.started_at instanceof Date
        ? r.started_at.toISOString()
        : r.started_at
          ? String(r.started_at)
          : null,
    active_now: active,
  }
}

async function devicesForPhone(pool, digits) {
  if (!digits || digits.length < 9) return []
  const { rows } = await pool.query(
    `WITH phone_txn_devices AS (
       SELECT DISTINCT trim(t.device_id::text) AS device_id
       FROM transactions t
       WHERE trim(coalesce(t.device_id::text, '')) <> ''
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
       SELECT DISTINCT trim(t.device_id::text) AS device_id
       FROM transactions t
       WHERE trim(coalesce(t.device_id::text, '')) <> ''
         AND (
           ${tzPhoneCanonicalSql("t.raw_payload->>'phoneNorm'")} = $1
           OR ${tzPhoneCanonicalSql("t.raw_payload->>'phone'")} = $1
           OR ${tzPhoneCanonicalSql("t.raw_payload->'sonicpesa'->'data'->>'msisdn'")} = $1
           OR ${tzPhoneCanonicalSql("t.raw_payload->'order_status_poll'->'data'->>'msisdn'")} = $1
         )
       UNION
       SELECT DISTINCT trim(dpr.device_id::text) AS device_id
       FROM device_phone_registry dpr
       WHERE trim(coalesce(dpr.device_id::text, '')) <> ''
         AND trim(coalesce(dpr.phone_number_normalized::text, '')) = $1
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
     )
     SELECT device_id FROM linked_devices WHERE device_id <> ''`,
    [digits],
  )
  return rows.map((r) => String(r.device_id))
}

async function devicesForInstallInstance(pool, installId) {
  const id = text(installId, 128)
  if (!id) return []
  const { rows } = await pool.query(
    `SELECT DISTINCT device_id::text AS device_id
     FROM app_installs
     WHERE install_instance_id = $1 AND trim(device_id::text) <> ''`,
    [id],
  )
  return rows.map((r) => String(r.device_id))
}

async function collectDeviceIds(pool, input) {
  const set = new Set()
  const deviceId = text(input.device_id ?? input.deviceId, 128)
  const phone = text(input.phone ?? input.payment_phone, 40)
  const orderId = text(input.order_id ?? input.orderId, 128)
  const externalId = text(input.external_id ?? input.provider_reference ?? input.transaction_id, 128)
  const accountId = text(input.account_id ?? input.accountId, 64)
  const installId = text(input.install_instance_id ?? input.installInstanceId, 128)

  if (deviceId) set.add(deviceId)

  const digits = normalizePhoneDigits(phone)
  if (digits) {
    for (const d of await devicesForPhone(pool, digits)) set.add(d)
  }

  if (installId) {
    for (const d of await devicesForInstallInstance(pool, installId)) set.add(d)
  }

  if (orderId || externalId) {
    const { rows } = await pool.query(
      `SELECT DISTINCT trim(device_id::text) AS device_id
       FROM transactions
       WHERE ($1::text <> '' AND order_id = $1)
          OR ($2::text <> '' AND external_id = $2)
          OR ($2::text <> '' AND order_id = $2)`,
      [orderId, externalId],
    )
    for (const r of rows) {
      if (r.device_id) set.add(String(r.device_id))
    }
  }

  if (accountId) {
    const ad = normalizePhoneDigits(accountId) || accountId
    const params = [accountId]
    let extra = ''
    if (ad.length >= 9) {
      extra = ` OR ${tzPhoneCanonicalSql('account_id')} = $2 OR ${tzPhoneCanonicalSql('phone_number')} = $2`
      params.push(ad)
    }
    const { rows } = await pool.query(
      `SELECT DISTINCT device_id::text AS device_id
       FROM device_intelligence_registry
       WHERE account_id = $1 OR phone_number = $1${extra}`,
      params,
    )
    for (const r of rows) {
      if (r.device_id) set.add(String(r.device_id))
    }
  }

  return [...set].filter(Boolean)
}

async function loadTransactions(pool, { deviceIds, orderId, externalId, phoneDigits }) {
  const cond = ['1=1']
  const params = []
  let i = 1
  const parts = []
  if (deviceIds.length) {
    parts.push(`t.device_id = ANY($${i}::text[])`)
    params.push(deviceIds)
    i += 1
  }
  if (orderId) {
    parts.push(`t.order_id = $${i}`)
    params.push(orderId)
    i += 1
  }
  if (externalId) {
    parts.push(`(t.external_id = $${i} OR t.order_id = $${i})`)
    params.push(externalId)
    i += 1
  }
  if (phoneDigits && phoneDigits.length >= 9) {
    parts.push(`${tzPhoneCanonicalSql('t.phone::text')} = $${i}`)
    params.push(phoneDigits)
    i += 1
    parts.push(`(
      ${tzPhoneCanonicalSql("t.raw_payload->>'phoneNorm'")} = $${i}
      OR ${tzPhoneCanonicalSql("t.raw_payload->>'phone'")} = $${i}
      OR ${tzPhoneCanonicalSql("t.raw_payload->'sonicpesa'->'data'->>'msisdn'")} = $${i}
      OR ${tzPhoneCanonicalSql("t.raw_payload->'order_status_poll'->'data'->>'msisdn'")} = $${i}
    )`)
    params.push(phoneDigits)
    i += 1
    parts.push(`t.device_id IN (
      SELECT dpr.device_id::text FROM device_phone_registry dpr
      WHERE dpr.phone_number_normalized = $${i}
    )`)
    params.push(phoneDigits)
    i += 1
  }
  if (parts.length === 0) return []
  cond.push(`(${parts.join(' OR ')})`)
  const { rows } = await pool.query(
    `SELECT t.*, p.name AS plan_name,
            EXISTS (
              SELECT 1 FROM device_subscriptions ds
              WHERE ds.device_id = t.device_id
                AND ds.transaction_id = t.order_id
                AND ds.status = 'active'
                AND ds.expires_at > now()
            )::text AS subscription_linked
     FROM transactions t
     LEFT JOIN plans p ON p.id = t.plan_id AND p.deleted_at IS NULL
     WHERE ${cond.join(' AND ')}
     ORDER BY t.created_at DESC
     LIMIT 100`,
    params,
  )
  return rows.map(mapTxnRow)
}

function buildSuggestedActions({ payments, subscriptions, devices, phoneDigits }) {
  const actions = []
  const completed = payments.completed || []
  const pending = payments.pending || []
  const failed = payments.failed || []
  const activeSubs = subscriptions.active || []

  if (completed.length && !activeSubs.length) {
    const latest = completed[0]
    actions.push({
      action: 'retry_reconciliation',
      label: 'Retry payment reconciliation',
      reason: `Completed payment ${latest.order_id} but no active subscription found on linked devices.`,
      order_id: latest.order_id,
    })
    actions.push({
      action: 'force_activate',
      label: 'Force activate from completed transaction',
      reason: 'Only if provider confirms payment completed.',
      order_id: latest.order_id,
    })
  }

  if (pending.length) {
    actions.push({
      action: 'retry_reconciliation',
      label: 'Retry pending payment check',
      reason: 'Payment still pending — user may have paid but webhook delayed.',
      order_id: pending[0].order_id,
    })
  }

  if (failed.length && !completed.length && !activeSubs.length) {
    actions.push({
      action: 'ask_pay_again',
      label: 'Ask user to pay again',
      reason: failed[0].last_provider_response || 'Latest payment attempt failed.',
      order_id: failed[0].order_id,
    })
    actions.push({
      action: 'contact_provider',
      label: 'Contact payment provider',
      reason: `Provider: ${failed[0].provider_label}`,
      order_id: failed[0].order_id,
    })
  }

  if (phoneDigits && activeSubs.length && devices.length > 1) {
    const owner = activeSubs[0]?.device_id
    if (owner) {
      actions.push({
        action: 'force_transfer',
        label: 'Force transfer subscription',
        reason: 'Active subscription on a different device than user expects.',
        payment_phone: phoneDigits,
        source_device_id: owner,
      })
    }
  }

  if (!payments.completed?.length && !payments.pending?.length && !payments.failed?.length) {
    actions.push({
      action: 'ask_pay_again',
      label: 'No payment records found',
      reason: 'No matching transactions — user may not have completed checkout.',
    })
  }

  if (activeSubs.length) {
    actions.push({
      action: 'refresh_subscription',
      label: 'Refresh subscription status',
      reason: 'Re-read live access state for device.',
      device_id: activeSubs[0].device_id,
    })
  }

  return actions
}

function buildDiagnosis({ payments, subscriptions, devices }) {
  const reasons = []
  const completed = payments.completed || []
  const active = subscriptions.active || []

  if (completed.length && !active.length) {
    reasons.push('Payment marked completed but subscription not active on any linked device.')
  }
  if ((payments.pending || []).length) {
    reasons.push('Pending payment exists — activation may still be in progress.')
  }
  if ((payments.failed || []).length && !completed.length) {
    reasons.push('Recent payment attempts failed or timed out.')
  }
  if (active.length && devices.length > 1) {
    reasons.push('Multiple devices linked — subscription may be on a sibling device_id.')
  }
  if (!completed.length && !active.length && !(payments.failed || []).length && !(payments.pending || []).length) {
    reasons.push('No payment or subscription records matched this search.')
  }

  let summary = 'No issues detected.'
  if (reasons.length) summary = reasons[0]

  return { summary, not_activated_reasons: reasons }
}

/**
 * @param {Record<string, string>} input
 */
export async function investigateCustomerPayment(input = {}) {
  const pool = requirePool()
  const query = {
    phone: text(input.phone ?? input.payment_phone, 40) || null,
    device_id: text(input.device_id ?? input.deviceId, 128) || null,
    order_id: text(input.order_id ?? input.orderId, 128) || null,
    external_id: text(input.external_id ?? input.provider_reference, 128) || null,
    transaction_id: text(input.transaction_id ?? input.transactionId, 128) || null,
    account_id: text(input.account_id ?? input.accountId, 64) || null,
    install_instance_id: text(input.install_instance_id ?? input.installInstanceId, 128) || null,
  }
  if (query.transaction_id && !query.order_id) query.order_id = query.transaction_id

  const hasInput = Object.values(query).some(Boolean)
  if (!hasInput) {
    return { ok: false, error: 'At least one search field is required' }
  }

  const phoneDigits = normalizePhoneDigits(query.phone)
  const deviceIds = await collectDeviceIds(pool, query)

  const txnRows = await loadTransactions(pool, {
    deviceIds,
    orderId: query.order_id,
    externalId: query.external_id || query.transaction_id,
    phoneDigits,
  })
  for (const t of txnRows) {
    if (t.device_id) deviceIds.push(t.device_id)
  }
  const uniqueDevices = [...new Set(deviceIds.filter(Boolean))]

  let subs = []
  if (uniqueDevices.length) {
    const { rows } = await pool.query(
      `SELECT * FROM device_subscriptions WHERE device_id = ANY($1::text[])`,
      [uniqueDevices],
    )
    subs = rows
  }

  const nowMs = Date.now()
  const mappedSubs = subs.map((r) => mapSubRow(r, nowMs))
  const activeSubs = mappedSubs.filter((s) => s.active_now)
  const expiredSubs = mappedSubs.filter((s) => !s.active_now)

  const payments = { completed: [], pending: [], failed: [] }
  for (const t of txnRows) {
    const st = String(t.status).toLowerCase()
    if (st === 'completed') payments.completed.push(t)
    else if (st === 'pending') payments.pending.push(t)
    else payments.failed.push(t)
  }

  const deviceProfiles = []
  for (const d of uniqueDevices.slice(0, 25)) {
    const access = await getDeviceSubscriptionAccessState(d, null).catch(() => null)
    const { rows: installs } = await pool.query(
      `SELECT install_instance_id, installed_at
       FROM app_installs WHERE device_id = $1 ORDER BY installed_at DESC LIMIT 5`,
      [d],
    )
    const { rows: intel } = await pool.query(
      `SELECT phone_number, account_id, block_reason, updated_at
       FROM device_intelligence_registry WHERE device_id = $1 LIMIT 1`,
      [d],
    )
    deviceProfiles.push({
      device_id: d,
      install_instances: installs.map((r) => ({
        install_instance_id: String(r.install_instance_id ?? ''),
        installed_at:
          r.installed_at instanceof Date ? r.installed_at.toISOString() : String(r.installed_at ?? ''),
      })),
      intelligence: intel[0]
        ? {
            phone_number: String(intel[0].phone_number ?? ''),
            account_id: String(intel[0].account_id ?? ''),
            block_reason: intel[0].block_reason != null ? String(intel[0].block_reason) : null,
          }
        : null,
      access: access
        ? {
            active_now: access.active_now === true,
            blocked_now: access.blocked_now === true,
            status: String(access.status ?? ''),
            expires_at:
              access.expires_at instanceof Date
                ? access.expires_at.toISOString()
                : access.expires_at
                  ? String(access.expires_at)
                  : null,
            block_reason: access.block_reason != null ? String(access.block_reason) : null,
          }
        : null,
      subscription: mappedSubs.find((s) => s.device_id === d) ?? null,
    })
  }

  let paymentPhoneOwner = null
  if (phoneDigits) {
    paymentPhoneOwner = await findActiveDeviceIdForPaymentPhone(query.phone || phoneDigits).catch(() => null)
  }

  let auditLogs = []
  if (uniqueDevices.length) {
    const { rows } = await pool.query(
      `SELECT id, actor, event_type, status, detail, metadata, created_at
       FROM security_events
       WHERE actor = ANY($1::text[])
          OR metadata->>'source_device_id' = ANY($1::text[])
          OR metadata->>'target_device_id' = ANY($1::text[])
          OR metadata->>'device_id' = ANY($1::text[])
       ORDER BY created_at DESC
       LIMIT 40`,
      [uniqueDevices],
    )
    auditLogs = rows.map((r) => ({
      id: String(r.id ?? ''),
      actor: String(r.actor ?? ''),
      event_type: String(r.event_type ?? ''),
      status: String(r.status ?? ''),
      detail: String(r.detail ?? ''),
      metadata: r.metadata && typeof r.metadata === 'object' ? r.metadata : {},
      created_at:
        r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at ?? ''),
    }))
  }

  const diagnosis = buildDiagnosis({ payments, subscriptions: { active: activeSubs }, devices: uniqueDevices })
  const suggested_actions = buildSuggestedActions({
    payments,
    subscriptions: { active: activeSubs },
    devices: uniqueDevices,
    phoneDigits,
  })

  return {
    ok: true,
    searched_at: new Date().toISOString(),
    query: {
      ...query,
      phone_normalized: phoneDigits || null,
    },
    customer: {
      phone_normalized: phoneDigits || null,
      payment_phone_owner_device_id: paymentPhoneOwner,
      matched_device_count: uniqueDevices.length,
    },
    devices: deviceProfiles,
    subscriptions: {
      active: activeSubs,
      expired: expiredSubs,
    },
    payments,
    suggested_actions,
    diagnosis,
    audit_logs: auditLogs,
  }
}
