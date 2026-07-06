#!/usr/bin/env node
/**
 * Payment Orders search + filter end-to-end verification (VPS-first).
 *
 * Usage:
 *   VPS_API=https://api.osmanitv.com ADMIN_TOKEN=3030 node server/scripts/verify-payment-orders-search.mjs
 *   PHONE=0615332235 DEVICE_ID=... ORDER_ID=... node server/scripts/verify-payment-orders-search.mjs
 */
import {
  buildPaymentOrderSearchClause,
  isExactDeviceId,
  ledgerStatusFilterSql,
  listPaymentOrdersLedger,
  countPaymentOrdersLedger,
} from '../src/lib/paymentOrderLedger.js'
import { normalizePhoneDigits } from '../src/billingStore.js'

const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
const PHONE = process.env.PHONE || '0615332235'
const DEVICE_ID = process.env.DEVICE_ID || ''
const ORDER_ID = process.env.ORDER_ID || ''

const TABS = ['all', 'PENDING', 'SUCCESS', 'FAILED', 'MANUALLY_APPROVED']

const results = []

function record(name, pass, detail = '') {
  results.push({ name, pass, detail })
  const mark = pass ? 'PASS' : 'FAIL'
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`)
}

function pct(sorted, p) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]
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

function assertUnitBuilders() {
  record('unit: isExactDeviceId rejects short', !isExactDeviceId('abc'))
  record('unit: isExactDeviceId accepts 64 hex', isExactDeviceId('a'.repeat(64)))
  record('unit: phone normalize 0615…', normalizePhoneDigits('0615332235') === '255615332235')
  record('unit: phone normalize +255…', normalizePhoneDigits('+255615332235') === '255615332235')
  record('unit: phone normalize 255…', normalizePhoneDigits('255615332235') === '255615332235')
  const phoneClause = buildPaymentOrderSearchClause('0615332235', 1)
  record('unit: phone search uses canonical bind', phoneClause.params[0] === '255615332235')
  const devClause = buildPaymentOrderSearchClause('a'.repeat(64), 1)
  record('unit: device search exact equality', devClause.clause.includes('t.device_id = $1'))
  record('unit: SUCCESS filter excludes manual', ledgerStatusFilterSql('SUCCESS').includes('MANUALLY_APPROVED'))
  record('unit: FAILED filter includes provider_initiation failed', ledgerStatusFilterSql('FAILED').includes("provider_initiation"))
  record('unit: PENDING filter excludes failed initiation', ledgerStatusFilterSql('PENDING').includes("<> 'failed'"))
  record('unit: MANUAL OK filter', ledgerStatusFilterSql('MANUALLY_APPROVED').includes('MANUALLY_APPROVED'))
}

async function timedAdmin(path) {
  const latencies = []
  for (let i = 0; i < 5; i++) {
    const r = await adminGet(path)
    latencies.push(r.ms)
  }
  latencies.sort((a, b) => a - b)
  return { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99) }
}

async function verifyLiveApi() {
  const health = await fetch(`${API}/api/health`).then((r) => r.json())
  const poolBefore = health.pool ?? null

  const listAll = await adminGet('/admin/payment-orders?limit=3')
  record('live: list all', listAll.status === 200 && Array.isArray(listAll.body?.rows))
  record('live: total field present', typeof listAll.body?.total === 'number')

  const sample = listAll.body?.rows?.[0]
  const samplePhone = sample?.phone || sample?.normalizedPhone || ''
  const sampleDevice = sample?.deviceId || ''
  const sampleOrder = sample?.orderId || ''

  const phoneForms = [PHONE, `+${normalizePhoneDigits(PHONE)}`, normalizePhoneDigits(PHONE)]
  for (const form of phoneForms) {
    const r = await adminGet(`/admin/payment-orders?search=${encodeURIComponent(form)}&limit=50`)
    record(`live: phone search ${form}`, r.status === 200 && Array.isArray(r.body?.rows))
  }

  if (DEVICE_ID || sampleDevice) {
    const did = DEVICE_ID || sampleDevice
    const r = await adminGet(`/admin/payment-orders?search=${encodeURIComponent(did)}&limit=50`)
    const allMatch = (r.body?.rows ?? []).every((row) => row.deviceId === did)
    record('live: device ID search', r.status === 200 && (r.body?.rows?.length === 0 || allMatch))
  } else {
    record('live: device ID search', true, 'skipped — no sample device')
  }

  if (ORDER_ID || sampleOrder) {
    const oid = ORDER_ID || sampleOrder
    const r = await adminGet(`/admin/payment-orders?search=${encodeURIComponent(oid)}&limit=5`)
    const hit = (r.body?.rows ?? []).some((row) => row.orderId === oid)
    record('live: order ID search', r.status === 200 && hit)
  } else {
    record('live: order ID search', true, 'skipped — no sample order')
  }

  for (const tab of TABS) {
    const r = await adminGet(`/admin/payment-orders?status=${tab}&limit=10`)
    const ok = r.status === 200 && Array.isArray(r.body?.rows)
    let detail = `n=${r.body?.rows?.length ?? 0}`
    if (tab === 'SUCCESS' && ok) {
      const bad = (r.body.rows ?? []).filter((row) => row.ledgerStatus === 'MANUALLY_APPROVED')
      if (bad.length) detail += ` MANUAL_LEAK=${bad.length}`
      record(`live: tab ${tab}`, bad.length === 0, detail)
    } else if (tab === 'FAILED' && ok) {
      const bad = (r.body.rows ?? []).filter(
        (row) => !['FAILED', 'RECOVERY_REJECTED'].includes(row.ledgerStatus),
      )
      record(`live: tab ${tab}`, bad.length === 0, detail)
    } else if (tab === 'PENDING' && ok) {
      const bad = (r.body.rows ?? []).filter(
        (row) => !['PENDING', 'INITIATED'].includes(row.ledgerStatus),
      )
      record(`live: tab ${tab}`, bad.length === 0, detail)
    } else if (tab === 'MANUALLY_APPROVED' && ok) {
      const bad = (r.body.rows ?? []).filter((row) => row.ledgerStatus !== 'MANUALLY_APPROVED')
      record(`live: tab ${tab}`, bad.length === 0, detail)
    } else {
      record(`live: tab ${tab}`, ok, detail)
    }
  }

  if (samplePhone || normalizePhoneDigits(PHONE)) {
    const q = encodeURIComponent(PHONE)
    for (const tab of TABS) {
      const r = await adminGet(`/admin/payment-orders?status=${tab}&search=${q}&limit=50`)
      record(`live: phone+tab ${tab}`, r.status === 200 && Array.isArray(r.body?.rows))
    }
  }

  const empty = await adminGet('/admin/payment-orders?search=__no_match_xyz_99999__&limit=10')
  record('live: empty result', empty.status === 200 && (empty.body?.rows?.length ?? 0) === 0)

  const lat = {
    all: await timedAdmin('/admin/payment-orders?limit=50'),
    phone: await timedAdmin(`/admin/payment-orders?search=${encodeURIComponent(PHONE)}&limit=50`),
    pending: await timedAdmin('/admin/payment-orders?status=PENDING&limit=50'),
  }
  if (DEVICE_ID || sampleDevice) {
    lat.device = await timedAdmin(
      `/admin/payment-orders?search=${encodeURIComponent(DEVICE_ID || sampleDevice)}&limit=50`,
    )
  }

  const poolAfter = await fetch(`${API}/api/health`).then((r) => r.json()).then((h) => h.pool ?? null)

  return { health, poolBefore, poolAfter, lat }
}

async function verifyLocalDbIfAvailable() {
  if (!process.env.DATABASE_URL) {
    record('local: DATABASE_URL list', true, 'skipped')
    return null
  }
  try {
    const rows = await listPaymentOrdersLedger({ status: 'all', limit: 3 })
    const total = await countPaymentOrdersLedger({ status: 'all' })
    record('local: listPaymentOrdersLedger', Array.isArray(rows))
    record('local: countPaymentOrdersLedger', total >= rows.length)
    return { rows, total }
  } catch (e) {
    record('local: DATABASE_URL list', false, e.message)
    return null
  }
}

async function main() {
  console.log(`\n=== Payment Orders Search Verification ===\nAPI: ${API}\n`)
  assertUnitBuilders()
  await verifyLocalDbIfAvailable()
  const live = await verifyLiveApi()
  const failed = results.filter((r) => !r.pass)
  const pass = failed.length === 0
  console.log('\n--- Summary ---')
  console.log(JSON.stringify({
    pass,
    total: results.length,
    failed: failed.length,
    commit: live?.health?.commit ?? null,
    pool_before: live?.poolBefore ?? null,
    pool_after: live?.poolAfter ?? null,
    latency: live?.lat ?? null,
    failures: failed,
  }, null, 2))
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
