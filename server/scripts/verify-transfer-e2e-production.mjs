#!/usr/bin/env node
/**
 * Production-safe Hamisha transfer end-to-end verification.
 *
 * Creates two ephemeral device IDs, grants source via admin manual subscription,
 * runs transfer in manual mode, verifies metadata parity and instant revocation.
 *
 * Usage:
 *   ADMIN_TOKEN=3030 node server/scripts/verify-transfer-e2e-production.mjs
 */
import crypto from 'node:crypto'

const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '') + '/api'
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
const PIN = String(process.env.ADMIN_PIN || process.env.ADMIN_SENSITIVE_ACTION_PASSWORD || '3030').trim()
const PHONE = String(process.env.TRANSFER_TEST_PHONE || '255678089174').trim()

const report = {
  at: new Date().toISOString(),
  api: API,
  pass: true,
  timings_ms: {},
  steps: {},
}

function fail(msg, extra = {}) {
  report.pass = false
  report.error = msg
  Object.assign(report, extra)
  console.error('FAIL', msg)
}

async function json(path, opts = {}) {
  const t0 = Date.now()
  const res = await fetch(`${API}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = { _raw: text.slice(0, 400) }
  }
  return { status: res.status, body, ms: Date.now() - t0 }
}

function deviceId(prefix) {
  return crypto.createHash('sha256').update(`${prefix}:${Date.now()}:${crypto.randomUUID()}`).digest('hex')
}

async function verifyDevice(deviceId) {
  const v = await json('/subscription/verify', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ device_id: deviceId }),
  })
  return v
}

async function main() {
  console.log('=== Transfer E2E Production Verify ===')
  console.log('API:', API)

  const health = await json('/health', { headers: {} })
  report.commit = health.body?.commit || null
  console.log('commit:', String(report.commit || '').slice(0, 12))

  const sourceId = deviceId('transfer-e2e-src')
  const targetId = deviceId('transfer-e2e-tgt')
  report.source_device_id = sourceId
  report.target_device_id = targetId

  const dcBefore = await json('/settings/device-control')
  if (dcBefore.status !== 200) {
    fail(`device-control GET ${dcBefore.status}`)
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }
  const originalMode = dcBefore.body?.transferMode || 'confirmation'
  report.steps.device_control_before = {
    transferMode: originalMode,
    pending: dcBefore.body?.pending?.length ?? 0,
    logs: dcBefore.body?.logs?.length ?? 0,
  }

  if (originalMode !== 'manual') {
    const putMode = await json('/settings/device-control', {
      method: 'PUT',
      body: JSON.stringify({
        transferMode: 'manual',
        dailyLimit: dcBefore.body?.dailyLimit ?? 5,
        weeklyLimit: dcBefore.body?.weeklyLimit ?? 15,
        cooldownMinutes: dcBefore.body?.cooldownMinutes ?? 60,
        phoneGateEnabled: dcBefore.body?.phoneGateEnabled !== false,
      }),
    })
    if (putMode.body?.transferMode !== 'manual') {
      fail('could not switch transfer mode to manual for e2e', { putMode })
    }
  }

  const grantStart = Date.now()
  const grant = await json('/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({
      device_id: sourceId,
      plan_id: Number(process.env.TRANSFER_TEST_PLAN_ID || 2),
      phone: PHONE,
      pin: PIN,
      note: 'transfer-e2e-verify',
    }),
  })
  report.timings_ms.grant = Date.now() - grantStart
  if (grant.status !== 200 && grant.status !== 201) {
    fail(`manual grant failed HTTP ${grant.status}`, { grant: grant.body })
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }

  const srcBefore = await verifyDevice(sourceId)
  report.steps.source_before = {
    active: srcBefore.body?.active,
    expires_at: srcBefore.body?.expires_at,
    amount: srcBefore.body?.amount,
    plan_name: srcBefore.body?.plan_name,
    remaining_days: srcBefore.body?.remaining_days,
    duration_days: srcBefore.body?.duration_days,
  }
  if (!srcBefore.body?.active) {
    fail('source not active after grant', { srcBefore: srcBefore.body })
  }

  const tgtBefore = await verifyDevice(targetId)
  report.steps.target_before = { active: tgtBefore.body?.active }
  if (tgtBefore.body?.active) {
    fail('target unexpectedly active before transfer')
  }

  await json('/device/phone', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ device_id: sourceId, phone: PHONE }),
  })

  const reqStart = Date.now()
  const req = await json('/transfer/request', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ source_device_id: sourceId, payment_phone: PHONE }),
  })
  report.timings_ms.request = Date.now() - reqStart
  report.steps.request = req.body
  if (req.status !== 200 || !req.body?.code) {
    fail(`transfer request failed HTTP ${req.status}`, { req: req.body })
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }

  const dupReq = await json('/transfer/request', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ source_device_id: sourceId, payment_phone: PHONE }),
  })
  report.steps.duplicate_request = { status: dupReq.status, body: dupReq.body }
  if (dupReq.status !== 409 || dupReq.body?.code !== 'ACTIVE_TRANSFER_EXISTS') {
    fail('duplicate transfer request should return ACTIVE_TRANSFER_EXISTS', { dupReq })
  }

  const confirmStart = Date.now()
  const confirm = await json('/transfer/confirm', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ code: req.body.code, target_device_id: targetId }),
  })
  report.timings_ms.confirm = Date.now() - confirmStart
  report.steps.confirm = confirm.body
  if (confirm.status !== 200 || !confirm.body?.transferred) {
    fail(`transfer confirm failed HTTP ${confirm.status}`, { confirm: confirm.body })
    console.log(JSON.stringify(report, null, 2))
    process.exit(1)
  }

  const srcAfter = await verifyDevice(sourceId)
  const tgtAfter = await verifyDevice(targetId)
  report.steps.source_after = {
    active: srcAfter.body?.active,
    expires_at: srcAfter.body?.expires_at,
    remaining_days: srcAfter.body?.remaining_days,
  }
  report.steps.target_after = {
    active: tgtAfter.body?.active,
    expires_at: tgtAfter.body?.expires_at,
    amount: tgtAfter.body?.amount,
    plan_name: tgtAfter.body?.plan_name,
    remaining_days: tgtAfter.body?.remaining_days,
    duration_days: tgtAfter.body?.duration_days,
  }

  if (srcAfter.body?.active) fail('source still active after transfer')
  if (!tgtAfter.body?.active) fail('target not active after transfer')
  if (String(tgtAfter.body?.expires_at) !== String(srcBefore.body?.expires_at)) {
    fail('expiry mismatch after transfer', {
      before: srcBefore.body?.expires_at,
      after: tgtAfter.body?.expires_at,
    })
  }
  if (Number(tgtAfter.body?.remaining_days) !== Number(srcBefore.body?.remaining_days)) {
    fail('remaining_days mismatch after transfer', {
      before: srcBefore.body?.remaining_days,
      after: tgtAfter.body?.remaining_days,
    })
  }
  if (tgtAfter.body?.amount != null && srcBefore.body?.amount != null) {
    if (Number(tgtAfter.body.amount) !== Number(srcBefore.body.amount)) {
      fail('amount mismatch after transfer', {
        before: srcBefore.body?.amount,
        after: tgtAfter.body?.amount,
      })
    }
  }

  const replay = await json('/transfer/confirm', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ code: req.body.code, target_device_id: targetId }),
  })
  report.steps.replay_confirm = { status: replay.status, body: replay.body }
  if (replay.status === 200 && replay.body?.transferred === true) {
    fail('OTP replay succeeded — code must be single-use')
  }

  const codes = await json('/transfer-codes')
  const used = Array.isArray(codes.body)
    ? codes.body.find((c) => c.code === req.body.code)
    : null
  report.steps.admin_code_status = used?.status || null

  if (originalMode !== 'manual') {
    await json('/settings/device-control', {
      method: 'PUT',
      body: JSON.stringify({
        transferMode: originalMode,
        dailyLimit: dcBefore.body?.dailyLimit ?? 5,
        weeklyLimit: dcBefore.body?.weeklyLimit ?? 15,
        cooldownMinutes: dcBefore.body?.cooldownMinutes ?? 60,
        phoneGateEnabled: dcBefore.body?.phoneGateEnabled !== false,
      }),
    })
  }

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
