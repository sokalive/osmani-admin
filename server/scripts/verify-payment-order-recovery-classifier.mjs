#!/usr/bin/env node
/**
 * Payment Order recovery lifecycle classifier — unit + live VPS audit.
 */
import {
  classifyPaymentOrderRecovery,
  isStrictUnresolvedCompletedOrder,
  parseMovedTransactionId,
  RECOVERY_CLASS,
} from '../src/lib/paymentOrderRecoveryClassifier.js'

const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()

const results = []
const BEFORE_COUNTS = {
  'Already Active': 130,
  Transferred: 192,
  'Manual Grant Override': 19,
  'Superseded / Stacked': 25,
  'Needs Review': 31,
  Expired: 173,
}

function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function unit(name, fn) {
  try {
    const ok = fn()
    record(`unit: ${name}`, ok === true, ok === true ? '' : String(ok))
  } catch (e) {
    record(`unit: ${name}`, false, e.message)
  }
}

function row(overrides) {
  return {
    order_id: 'osm_sp_test_order_1',
    status: 'completed',
    device_id: 'a'.repeat(64),
    sub_status: 'active',
    sub_expires_at: new Date(Date.now() + 86400000).toISOString(),
    sub_transaction_id: 'osm_sp_test_order_1',
    created_at: new Date(Date.now() - 86400000 * 30).toISOString(),
    completed_at: new Date(Date.now() - 86400000 * 29).toISOString(),
    ...overrides,
  }
}

function fanOutDevice(deviceId, orders, anchorOrderId) {
  const movedTxn = `moved:${deviceId}:${anchorOrderId}`
  return orders.map((o) =>
    row({
      order_id: o.id,
      device_id: deviceId,
      sub_transaction_id: movedTxn,
      sub_status: 'active',
      sub_expires_at: new Date(Date.now() + 86400000).toISOString(),
      created_at: o.createdAt,
      completed_at: o.completedAt,
      superseding_order_id: o.superseding ?? null,
    }),
  )
}

function runUnitTests() {
  unit('parseMovedTransactionId exact 64-char device', () => {
    const d = 'c'.repeat(64)
    const p = parseMovedTransactionId(`moved:${d}:osm_sp_order_xyz`)
    return p.isMoved && p.sourceDeviceId === d && p.embeddedTransactionId === 'osm_sp_order_xyz'
  })

  unit('parseMovedTransactionId legacy device id', () => {
    const p = parseMovedTransactionId('moved:verify_recovery_123:osm_sp_order_abc')
    return p.isMoved && p.legacy === true && p.embeddedTransactionId === 'osm_sp_order_abc'
  })

  unit('parseMovedTransactionId malformed', () => {
    const p = parseMovedTransactionId('moved:onlyonepart')
    return p.isMoved && p.malformed === true
  })

  unit('parseMovedTransactionId null safe', () => {
    const p = parseMovedTransactionId(null)
    return p.isMoved === false
  })

  unit('parseMovedTransactionId prefix collision safe', () => {
    const d = 'a'.repeat(64)
    const p = parseMovedTransactionId(`moved:${d}:osm_sp_order`)
    const p2 = parseMovedTransactionId(`moved:${d}:osm_sp_order_extra`)
    return p.embeddedTransactionId !== p2.embeddedTransactionId
  })

  unit('already active anchor', () => {
    const c = classifyPaymentOrderRecovery(row({}))
    return c.recoveryClass === RECOVERY_CLASS.ALREADY_ACTIVE && c.recoveryLabel === 'Already Active'
  })

  unit('no activation gap label exists', () => {
    const cases = [
      row({ sub_transaction_id: 'moved:x:y', sub_status: 'active' }),
      row({ sub_transaction_id: 'osm_sp_later', superseding_order_id: 'osm_sp_later' }),
      row({ sub_transaction_id: 'osm_sp_test_order_1', sub_expires_at: new Date(Date.now() - 1000).toISOString() }),
      row({ sub_transaction_id: 'manual_grant:1' }),
    ]
    return cases.every((r) => classifyPaymentOrderRecovery(r).recoveryLabel !== 'Activation Gap')
  })

  unit('no legacy Transferred label', () => {
    const cases = [
      row({ sub_transaction_id: `moved:${'b'.repeat(64)}:osm_sp_test_order_1` }),
      row({ sub_transaction_id: `moved:${'b'.repeat(64)}:other_order` }),
    ]
    return cases.every((r) => classifyPaymentOrderRecovery(r).recoveryLabel !== 'Transferred')
  })

  unit('system migration exact moved match', () => {
    const d = 'b'.repeat(64)
    const c = classifyPaymentOrderRecovery(
      row({ sub_transaction_id: `moved:${d}:osm_sp_test_order_1`, sub_status: 'active' }),
    )
    return c.recoveryClass === RECOVERY_CLASS.SYSTEM_MIGRATION
  })

  unit('system migration manual_grant embedded', () => {
    const d = 'b'.repeat(64)
    const c = classifyPaymentOrderRecovery(
      row({
        order_id: 'manual_grant:42',
        sub_transaction_id: `moved:${d}:manual_grant:42`,
        sub_status: 'active',
      }),
    )
    return c.recoveryClass === RECOVERY_CLASS.SYSTEM_MIGRATION
  })

  unit('3-order fan-out: anchor = SYSTEM_MIGRATION only', () => {
    const d = 'd'.repeat(64)
    const orders = fanOutDevice(d, [
      { id: 'osm_sp_order_a', createdAt: new Date(Date.now() - 86400000 * 10).toISOString(), completedAt: new Date(Date.now() - 86400000 * 9).toISOString() },
      { id: 'osm_sp_order_b', createdAt: new Date(Date.now() - 86400000 * 5).toISOString(), completedAt: new Date(Date.now() - 86400000 * 4).toISOString() },
      { id: 'osm_sp_order_c', createdAt: new Date(Date.now() - 86400000 * 2).toISOString(), completedAt: new Date(Date.now() - 86400000).toISOString() },
    ], 'osm_sp_order_c')
    const cls = orders.map((r) => classifyPaymentOrderRecovery(r).recoveryClass)
    return (
      cls[2] === RECOVERY_CLASS.SYSTEM_MIGRATION &&
      cls[0] !== RECOVERY_CLASS.SYSTEM_MIGRATION &&
      cls[0] !== RECOVERY_CLASS.HAMISHA_TRANSFER &&
      cls[1] !== RECOVERY_CLASS.SYSTEM_MIGRATION &&
      cls[1] !== RECOVERY_CLASS.HAMISHA_TRANSFER &&
      cls[0] === RECOVERY_CLASS.SUPERSEDED_STACKED &&
      cls[1] === RECOVERY_CLASS.SUPERSEDED_STACKED
    )
  })

  unit('10-order fan-out: only anchor migrates', () => {
    const d = 'e'.repeat(64)
    const anchor = 'osm_sp_anchor_10'
    const orders = []
    for (let i = 0; i < 10; i++) {
      orders.push({
        id: i === 9 ? anchor : `osm_sp_hist_${i}`,
        createdAt: new Date(Date.now() - 86400000 * (20 - i)).toISOString(),
        completedAt: new Date(Date.now() - 86400000 * (19 - i)).toISOString(),
      })
    }
    const rows = fanOutDevice(d, orders, anchor)
    let migration = 0
    let hamisha = 0
    let superseded = 0
    for (const r of rows) {
      const c = classifyPaymentOrderRecovery(r)
      if (c.recoveryClass === RECOVERY_CLASS.SYSTEM_MIGRATION) migration++
      if (c.recoveryClass === RECOVERY_CLASS.HAMISHA_TRANSFER) hamisha++
      if (c.recoveryClass === RECOVERY_CLASS.SUPERSEDED_STACKED) superseded++
    }
    return migration === 1 && hamisha === 0 && superseded === 9
  })

  unit('hamisha transfer causal', () => {
    const d = 'f'.repeat(64)
    const transferAt = new Date(Date.now() - 3600000).toISOString()
    const c = classifyPaymentOrderRecovery(
      row({
        device_id: d,
        sub_transaction_id: 'osm_sp_test_order_1',
        sub_status: 'pending',
        hamisha_transfer_id: '99',
        hamisha_target_device_id: 'g'.repeat(64),
        hamisha_transfer_completed_at: transferAt,
        completed_at: new Date(Date.now() - 86400000).toISOString(),
      }),
    )
    return c.recoveryClass === RECOVERY_CLASS.HAMISHA_TRANSFER
  })

  unit('hamisha not inferred from lifetime source device only', () => {
    const c = classifyPaymentOrderRecovery(
      row({
        sub_transaction_id: `moved:${'h'.repeat(64)}:other_order`,
        sub_status: 'active',
      }),
    )
    return c.recoveryClass !== RECOVERY_CLASS.HAMISHA_TRANSFER
  })

  unit('historical order on hamisha source device not hamisha', () => {
    const d = 'i'.repeat(64)
    const c = classifyPaymentOrderRecovery(
      row({
        order_id: 'osm_sp_old_order',
        device_id: d,
        sub_transaction_id: 'osm_sp_active_order',
        sub_status: 'pending',
        hamisha_transfer_id: '88',
        hamisha_target_device_id: 'j'.repeat(64),
        hamisha_transfer_completed_at: new Date().toISOString(),
      }),
    )
    return c.recoveryClass !== RECOVERY_CLASS.HAMISHA_TRANSFER
  })

  unit('hamisha rejected when transfer before order', () => {
    const c = classifyPaymentOrderRecovery(
      row({
        sub_transaction_id: 'osm_sp_test_order_1',
        sub_status: 'pending',
        hamisha_transfer_id: '77',
        hamisha_transfer_completed_at: new Date(Date.now() - 86400000 * 60).toISOString(),
        completed_at: new Date(Date.now() - 86400000).toISOString(),
      }),
    )
    return c.recoveryClass !== RECOVERY_CLASS.HAMISHA_TRANSFER
  })

  unit('superseded stacked', () => {
    const c = classifyPaymentOrderRecovery(
      row({
        sub_transaction_id: 'osm_sp_newer_order',
        superseding_order_id: 'osm_sp_newer_order',
      }),
    )
    return c.recoveryClass === RECOVERY_CLASS.SUPERSEDED_STACKED
  })

  unit('expired natural', () => {
    const c = classifyPaymentOrderRecovery(
      row({
        sub_transaction_id: 'osm_sp_test_order_1',
        sub_expires_at: new Date(Date.now() - 3600000).toISOString(),
        sub_status: 'active',
      }),
    )
    return c.recoveryClass === RECOVERY_CLASS.EXPIRED
  })

  unit('admin revoked', () => {
    const c = classifyPaymentOrderRecovery(
      row({
        sub_transaction_id: 'osm_sp_test_order_1',
        sub_status: 'revoked',
        admin_revoked_at: new Date().toISOString(),
        admin_revoked_transaction_id: 'osm_sp_test_order_1',
        sub_expires_at: new Date(Date.now() + 86400000).toISOString(),
      }),
    )
    return c.recoveryClass === RECOVERY_CLASS.ADMIN_REVOKED
  })

  unit('manual grant override', () => {
    const c = classifyPaymentOrderRecovery(row({ sub_transaction_id: 'manual_grant:42' }))
    return c.recoveryClass === RECOVERY_CLASS.MANUAL_GRANT_OVERRIDE
  })

  unit('strict unresolved', () => {
    const r = row({
      sub_transaction_id: 'osm_sp_test_order_1',
      sub_status: 'inactive',
      admin_revoked_at: null,
      admin_revoked_transaction_id: null,
    })
    return (
      isStrictUnresolvedCompletedOrder(r) &&
      classifyPaymentOrderRecovery(r).recoveryClass === RECOVERY_CLASS.TRUE_UNRESOLVED
    )
  })

  unit('strict unresolved inactive sub', () => {
    const r = row({ sub_status: 'inactive', sub_transaction_id: 'osm_sp_test_order_1' })
    return isStrictUnresolvedCompletedOrder(r)
  })

  unit('not strict unresolved without sub bind', () => {
    const r = row({ sub_transaction_id: 'other_order' })
    return !isStrictUnresolvedCompletedOrder(r)
  })

  unit('malformed moved marker needs review', () => {
    const c = classifyPaymentOrderRecovery(
      row({ sub_transaction_id: 'moved:brokenonly', sub_status: 'active' }),
    )
    return c.recoveryClass === RECOVERY_CLASS.NEEDS_REVIEW
  })

  unit('null transaction_id needs review', () => {
    const c = classifyPaymentOrderRecovery(row({ sub_transaction_id: '', sub_status: 'inactive' }))
    return c.recoveryClass === RECOVERY_CLASS.NEEDS_REVIEW
  })
}

async function adminGet(path) {
  const t0 = Date.now()
  const res = await fetch(`${API}/api${path}`, {
    cache: 'no-store',
    headers: { 'X-Admin-Token': TOKEN },
  })
  const ms = Date.now() - t0
  const body = await res.json().catch(() => ({}))
  return { status: res.status, ms, body }
}

async function liveAudit() {
  const hints = {}
  const classes = {}
  const unresolved = []
  const orderIds = new Set()
  let activationGap = 0
  let transferredLegacy = 0
  let pages = 0

  for (let page = 1; page <= 20; page++) {
    const d = await adminGet(`/admin/payment-orders?status=SUCCESS&limit=50&page=${page}`)
    if (d.status !== 200) {
      record('live: list SUCCESS', false, `HTTP ${d.status}`)
      return null
    }
    pages++
    for (const r of d.body?.rows || []) {
      const label = r.recoveryLabel || r.recoveryHint || '?'
      hints[label] = (hints[label] || 0) + 1
      const cls = r.recoveryClass || label
      classes[cls] = (classes[cls] || 0) + 1
      if (r.orderId) orderIds.add(String(r.orderId))
      if (label === 'Activation Gap') activationGap++
      if (label === 'Transferred') transferredLegacy++
      if (r.recoveryClass === 'TRUE_UNRESOLVED' || label === 'Unresolved Activation') {
        unresolved.push({
          orderId: String(r.orderId).slice(0, 28),
          recoveryClass: r.recoveryClass,
          recoveryReason: r.recoveryReason,
          subTransactionId: String(r.subTransactionId || '').slice(0, 28),
          subStatus: r.status,
        })
      }
    }
    if (!d.body?.rows?.length || page >= (d.body?.totalPages || 1)) break
  }

  const total = Object.values(hints).reduce((a, b) => a + b, 0)

  record('live: no Activation Gap labels', activationGap === 0, `count=${activationGap}`)
  record('live: no legacy Transferred label', transferredLegacy === 0, `count=${transferredLegacy}`)
  record('live: recoveryClass field present', Object.keys(classes).some((k) => k.includes('_') || k === 'ALREADY_ACTIVE'))
  record('live: SUCCESS total reconciles', total === orderIds.size, `rows=${total} distinct=${orderIds.size}`)

  const audit = await adminGet('/runtime/payment-production-audit?days=90')
  const metrics = await adminGet('/runtime/sonicpesa-reliability-metrics?days=30').catch(() => ({ body: {} }))
  const critical =
    audit.body?.critical_unresolved_completed ??
    metrics.body?.critical_unresolved_completed ??
    null

  record(
    'live: critical_unresolved_completed = 0',
    critical === 0,
    `critical=${critical}`,
  )
  record(
    'live: UI unresolved count = 0 when critical=0',
    critical !== 0 || unresolved.length === 0,
    `unresolved=${unresolved.length}`,
  )

  if (unresolved.length > 0 && unresolved.length <= 20) {
    console.log('\n--- Unresolved Activation deep audit ---')
    console.log(JSON.stringify(unresolved, null, 2))
  } else if (unresolved.length > 20) {
    record('live: unresolved audit', false, `too many unresolved rows: ${unresolved.length}`)
  }

  const health = await fetch(`${API}/api/health`).then((r) => r.json())
  return { hints, classes, unresolved, critical, health, pages, total, distinct: orderIds.size, BEFORE_COUNTS }
}

async function main() {
  console.log(`\n=== Payment Order Recovery Classifier ===\nAPI: ${API}\n`)
  runUnitTests()
  const live = await liveAudit()
  const failed = results.filter((r) => !r.pass)
  console.log('\n--- Summary ---')
  console.log(
    JSON.stringify(
      {
        pass: failed.length === 0,
        total: results.length,
        failed: failed.length,
        commit: live?.health?.commit ?? null,
        pool: live?.health?.pool ?? null,
        beforeCounts: BEFORE_COUNTS,
        afterCounts: live?.hints ?? null,
        afterClasses: live?.classes ?? null,
        reconciliation: live ? { total: live.total, distinct: live.distinct } : null,
        unresolvedAudited: live?.unresolved?.length ?? 0,
        failures: failed,
      },
      null,
      2,
    ),
  )
  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
