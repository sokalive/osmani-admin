#!/usr/bin/env node
/**
 * Payment Order recovery lifecycle classifier — unit + live VPS audit.
 */
import {
  classifyPaymentOrderRecovery,
  isStrictUnresolvedCompletedOrder,
  RECOVERY_CLASS,
} from '../src/lib/paymentOrderRecoveryClassifier.js'

const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()

const results = []

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
    ...overrides,
  }
}

function runUnitTests() {
  unit('already active anchor', () => {
    const c = classifyPaymentOrderRecovery(row({}))
    return c.recoveryClass === RECOVERY_CLASS.ALREADY_ACTIVE && c.recoveryLabel === 'Already Active'
  })

  unit('no activation gap label exists', () => {
    const cases = [
      row({ sub_transaction_id: 'moved:x', sub_status: 'active' }),
      row({ sub_transaction_id: 'osm_sp_later', superseding_order_id: 'osm_sp_later' }),
      row({ sub_transaction_id: 'osm_sp_test_order_1', sub_expires_at: new Date(Date.now() - 1000).toISOString() }),
      row({ sub_transaction_id: 'manual_grant:1' }),
    ]
    return cases.every((r) => classifyPaymentOrderRecovery(r).recoveryLabel !== 'Activation Gap')
  })

  unit('transferred moved:*', () => {
    const c = classifyPaymentOrderRecovery(
      row({ sub_transaction_id: 'moved:abc:osm_sp_test_order_1', sub_status: 'active' }),
    )
    return c.recoveryClass === RECOVERY_CLASS.TRANSFERRED
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
  let activationGap = 0
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
      if (label === 'Activation Gap') activationGap++
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

  record('live: no Activation Gap labels', activationGap === 0, `count=${activationGap}`)
  record('live: recoveryClass field present', Object.keys(classes).some((k) => k.includes('_') || k === 'ALREADY_ACTIVE'))

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
  return { hints, classes, unresolved, critical, health, pages }
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
        afterCounts: live?.hints ?? null,
        afterClasses: live?.classes ?? null,
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
