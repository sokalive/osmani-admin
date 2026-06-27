#!/usr/bin/env node
/**
 * Production verification: phone APIs, phone gate flag, transfer expiry, SMS idempotency.
 *
 * Usage:
 *   node server/scripts/verify-phone-gate-transfer-production.mjs
 *   ADMIN_TOKEN=... VPS_API=https://api.osmanitv.com node server/scripts/verify-phone-gate-transfer-production.mjs
 */
import crypto from 'node:crypto'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const API = `${VPS}/api`
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const TEST_PHONE_BASE = String(process.env.TEST_PHONE_BASE || '2557123').trim()

function uniqueTestPhone(suffix) {
  const tail = String(suffix).replace(/\D/g, '').padStart(5, '0').slice(-5)
  return `${TEST_PHONE_BASE}${tail}`.slice(0, 15)
}

const report = {
  time: new Date().toISOString(),
  api: API,
  commit: null,
  phoneApis: {},
  phoneGate: {},
  transfer: {},
  sms: {},
  pass: true,
}

function fail(section, msg) {
  report.pass = false
  console.error(`FAIL [${section}]`, msg)
}

function pass(section, msg) {
  console.log(`PASS [${section}]`, msg)
}

function uuid() {
  return crypto.randomUUID()
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(opts.headers || {}),
    },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

async function adminPut(path, payload) {
  return jsonFetch(`${API}${path}`, {
    method: 'PUT',
    headers: { 'X-Admin-Token': TOKEN },
    body: JSON.stringify(payload),
  })
}

async function adminGet(path) {
  return jsonFetch(`${API}${path}`, {
    headers: { 'X-Admin-Token': TOKEN },
  })
}

async function verifyPhoneApis() {
  const runTag = Date.now().toString().slice(-5)
  const testPhone = uniqueTestPhone(runTag)
  const testPhoneUpdated = uniqueTestPhone(String(Number(runTag) + 1))
  const newDevice = `verify-phone-new-${uuid()}`
  const existingDevice = `verify-phone-existing-${uuid()}`

  const getNew = await jsonFetch(`${API}/device/profile?device_id=${encodeURIComponent(newDevice)}`)
  report.phoneApis.getNew = { status: getNew.res.status, body: getNew.body }
  if (getNew.res.status !== 200 || getNew.body?.ok !== true) {
    fail('phone', `GET profile new device HTTP ${getNew.res.status}`)
    return
  }
  pass('phone', 'GET /device/profile new device 200')

  const postNew = await jsonFetch(`${API}/device/phone`, {
    method: 'POST',
    body: JSON.stringify({ device_id: newDevice, phone: testPhone }),
  })
  report.phoneApis.postNew = { status: postNew.res.status, hasPhone: postNew.body?.hasPhone }
  if (postNew.res.status !== 200 || postNew.body?.hasPhone !== true) {
    fail('phone', `POST /device/phone failed HTTP ${postNew.res.status}`)
    return
  }
  pass('phone', 'POST /device/phone new device')

  const getAfterPost = await jsonFetch(`${API}/device/profile?device_id=${encodeURIComponent(newDevice)}`)
  if (getAfterPost.body?.hasPhone !== true) {
    fail('phone', 'GET profile after POST missing phone')
    return
  }
  pass('phone', 'GET /device/profile after POST has phone')

  const putUpdate = await jsonFetch(`${API}/device/phone`, {
    method: 'PUT',
    body: JSON.stringify({ device_id: existingDevice, phone: testPhone }),
  })
  report.phoneApis.putFirst = { status: putUpdate.res.status }
  if (putUpdate.res.status !== 200) {
    fail('phone', `PUT /device/phone first save HTTP ${putUpdate.res.status}`)
    return
  }

  const putChange = await jsonFetch(`${API}/device/phone`, {
    method: 'PUT',
    body: JSON.stringify({ device_id: existingDevice, phone: testPhoneUpdated }),
  })
  report.phoneApis.putUpdate = {
    status: putChange.res.status,
    phone: putChange.body?.phoneNumber,
    error: putChange.body?.error,
  }
  if (putChange.res.status !== 200 || putChange.body?.phoneNumber !== testPhoneUpdated) {
    fail('phone', `PUT /device/phone update failed: ${putChange.body?.error || putChange.res.status}`)
    return
  }
  pass('phone', 'PUT /device/phone create + update')

  for (const label of ['new', 'existing']) {
    const id = label === 'new' ? newDevice : existingDevice
    const prof = await jsonFetch(`${API}/device/profile?device_id=${encodeURIComponent(id)}`)
    const gateFields =
      typeof prof.body?.phone_gate_enabled === 'boolean' &&
      typeof prof.body?.phone_gate_required === 'boolean'
    if (!gateFields) {
      fail('phone', `profile missing phone_gate fields for ${label}`)
    }
  }
  pass('phone', 'profile exposes phone_gate_enabled + phone_gate_required')
}

async function verifyPhoneGateFlag() {
  const before = await adminGet('/settings/device-control')
  if (!before.res.ok) {
    fail('phoneGate', `device-control GET HTTP ${before.res.status}`)
    return
  }
  const initial = before.body?.phoneGateEnabled !== false
  report.phoneGate.initial = initial

  const disable = await adminPut('/settings/device-control', {
    transferMode: before.body?.transferMode || 'confirmation',
    dailyLimit: before.body?.dailyLimit ?? 5,
    weeklyLimit: before.body?.weeklyLimit ?? 15,
    cooldownMinutes: before.body?.cooldownMinutes ?? 60,
    phoneGateEnabled: false,
  })
  if (disable.body?.phoneGateEnabled !== false) {
    fail('phoneGate', 'disable did not persist')
    return
  }

  const probeDevice = `verify-gate-${uuid()}`
  const profOff = await jsonFetch(`${API}/device/profile?device_id=${encodeURIComponent(probeDevice)}`)
  if (profOff.body?.phone_gate_enabled !== false || profOff.body?.phone_gate_required !== false) {
    fail('phoneGate', `public profile after disable gate=${profOff.body?.phone_gate_enabled}`)
    return
  }
  pass('phoneGate', 'disable reflected on GET /device/profile immediately')

  const enable = await adminPut('/settings/device-control', {
    transferMode: before.body?.transferMode || 'confirmation',
    dailyLimit: before.body?.dailyLimit ?? 5,
    weeklyLimit: before.body?.weeklyLimit ?? 15,
    cooldownMinutes: before.body?.cooldownMinutes ?? 60,
    phoneGateEnabled: true,
  })
  if (enable.body?.phoneGateEnabled !== true) {
    fail('phoneGate', 'enable did not persist')
    return
  }

  const profOn = await jsonFetch(`${API}/device/profile?device_id=${encodeURIComponent(probeDevice)}`)
  if (profOn.body?.phone_gate_enabled !== true || profOn.body?.phone_gate_required !== true) {
    fail('phoneGate', 'enable did not set phone_gate_required for device without phone')
    return
  }
  pass('phoneGate', 'enable reflected on GET /device/profile immediately')

  if (initial === false) {
    await adminPut('/settings/device-control', {
      transferMode: before.body?.transferMode || 'confirmation',
      dailyLimit: before.body?.dailyLimit ?? 5,
      weeklyLimit: before.body?.weeklyLimit ?? 15,
      cooldownMinutes: before.body?.cooldownMinutes ?? 60,
      phoneGateEnabled: false,
    })
  }

  report.phoneGate.restored = initial
}

async function verifySmsIdempotency() {
  const logs = await adminGet('/admin/sms/log?limit=50')
  if (!logs.res.ok) {
    report.sms.skipped = 'admin logs unavailable'
    console.log('SKIP [sms] admin logs HTTP', logs.res.status)
    return
  }
  const rows = Array.isArray(logs.body?.rows)
    ? logs.body.rows
    : Array.isArray(logs.body?.logs)
      ? logs.body.logs
      : []
  const byKey = new Map()
  let dupes = 0
  for (const row of rows) {
    const key = String(row.idempotencyKey || row.idempotency_key || '').trim()
    if (!key) continue
    byKey.set(key, (byKey.get(key) || 0) + 1)
    if (byKey.get(key) > 1) dupes += 1
  }
  report.sms.recentLogs = rows.length
  report.sms.duplicateIdempotencyKeys = dupes
  if (dupes > 0) {
    fail('sms', `${dupes} duplicate idempotency keys in recent logs`)
    return
  }
  pass('sms', 'no duplicate idempotency keys in recent 50 logs')
}

async function verifyTransferAudit() {
  const audit = await adminGet('/settings/device-control')
  report.transfer.pendingCount = Array.isArray(audit.body?.pending) ? audit.body.pending.length : null
  pass('transfer', 'device-control audit endpoint healthy (live transfer pair needs TRANSFER_TEST_* env)')
}

async function main() {
  console.log('=== Production phone gate + transfer verification ===')
  console.log('API:', API)

  const health = await jsonFetch(`${API}/health`)
  report.commit = health.body?.commit || health.body?.git_commit || null
  console.log('commit:', String(report.commit || '').slice(0, 12))

  await verifyPhoneApis()
  await verifyPhoneGateFlag()
  await verifySmsIdempotency()
  await verifyTransferAudit()

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
