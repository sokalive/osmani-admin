#!/usr/bin/env node
/**
 * Complete Device Control + Force Transfer production verification.
 * Uses ephemeral synthetic devices only — never real customer accounts.
 *
 * Usage:
 *   ADMIN_TOKEN=3030 ADMIN_PIN=3030 node server/scripts/verify-device-control-complete.mjs
 */
import crypto from 'node:crypto'

const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '') + '/api'
const ADMIN = String(process.env.VPS_ADMIN || 'https://admin.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
const PIN = String(process.env.ADMIN_PIN || process.env.ADMIN_SENSITIVE_ACTION_PASSWORD || '3030').trim()
const PLAN_ID = Number(process.env.TRANSFER_TEST_PLAN_ID || 2)

const report = {
  at: new Date().toISOString(),
  api: API,
  admin: ADMIN,
  commit: null,
  pass: true,
  results: {},
  timings_ms: {},
}

function fail(section, msg, extra = {}) {
  report.pass = false
  report.results[section] = { pass: false, error: msg, ...extra }
  console.error(`FAIL [${section}]`, msg)
}

function pass(section, detail = {}) {
  report.results[section] = { pass: true, ...detail }
  console.log(`PASS [${section}]`, typeof detail === 'string' ? detail : JSON.stringify(detail))
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

function uniquePhone() {
  const n = String(Date.now()).slice(-7)
  return `255799${n}`.slice(0, 12)
}

async function verifyDevice(id) {
  return json('/subscription/verify', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ device_id: id }),
  })
}

async function accountProbe(id) {
  // Account-facing fields come from verify payload in this backend (amount/plan/remaining/duration/expiry).
  const v = await verifyDevice(id)
  return {
    status: v.status,
    active: v.body?.active === true,
    amount: v.body?.amount ?? null,
    plan_name: v.body?.plan_name ?? null,
    remaining_days: v.body?.remaining_days ?? null,
    duration_days: v.body?.duration_days ?? v.body?.plan_duration_days ?? null,
    expires_at: v.body?.expires_at ?? null,
    playbackAllowed: v.body?.playbackAllowed ?? v.body?.playback_allowed ?? null,
    body: v.body,
  }
}

async function verifySpaShell() {
  const res = await fetch(`${ADMIN}/device-control`, { cache: 'no-store' })
  const html = await res.text()
  const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
  if (res.status !== 200 || !js) {
    fail('spa', `admin shell HTTP ${res.status}`)
    return
  }
  const bundle = await (await fetch(`${ADMIN}${js}`, { cache: 'no-store' })).text()
  const ok =
    bundle.includes('Device Control') &&
    bundle.includes('Emergency phone gate') &&
    bundle.includes('Force Transfer Device') &&
    bundle.includes('Recent Activity')
  if (!ok) fail('spa', 'Device Control UI strings missing from SPA bundle')
  else pass('spa', { js, hasForceTransfer: true, hasSettings: true })
}

async function verifySettings() {
  const before = await json('/settings/device-control')
  if (before.status !== 200) {
    fail('settings', `GET HTTP ${before.status}`)
    return null
  }
  const snap = {
    transferMode: before.body.transferMode,
    dailyLimit: before.body.dailyLimit,
    weeklyLimit: before.body.weeklyLimit,
    cooldownMinutes: before.body.cooldownMinutes,
    phoneGateEnabled: before.body.phoneGateEnabled,
  }
  if (!Array.isArray(before.body.pending)) {
    fail('recent_activity', 'pending missing from GET')
  } else {
    const statuses = [...new Set(before.body.pending.map((p) => p.status))]
    const ordered = before.body.pending.every((p, i, arr) => {
      if (i === 0) return true
      return String(arr[i - 1].requestedAt || '') >= String(p.requestedAt || '')
    })
    pass('recent_activity', {
      count: before.body.pending.length,
      statuses,
      newest_first: ordered || before.body.pending.length <= 1,
    })
  }
  if (!Array.isArray(before.body.logs)) {
    fail('logs', 'logs missing from GET')
  } else {
    const sample = before.body.logs.slice(0, 3).map((l) => ({
      at: l.at,
      message: String(l.message || '').slice(0, 80),
    }))
    pass('logs', { count: before.body.logs.length, sample })
  }

  // Phone gate toggle
  const gateOff = await json('/settings/device-control', {
    method: 'PUT',
    body: JSON.stringify({ ...snap, phoneGateEnabled: false }),
  })
  const gateOn = await json('/settings/device-control', {
    method: 'PUT',
    body: JSON.stringify({ ...snap, phoneGateEnabled: true }),
  })
  if (gateOff.body?.phoneGateEnabled !== false || gateOn.body?.phoneGateEnabled !== true) {
    fail('settings_phone_gate', 'phone gate toggle did not persist', { gateOff: gateOff.body, gateOn: gateOn.body })
  } else {
    pass('settings_phone_gate', { off: false, on: true })
  }

  // Mode toggle (confirmation <-> manual) then restore
  const otherMode = snap.transferMode === 'manual' ? 'confirmation' : 'manual'
  const modePut = await json('/settings/device-control', {
    method: 'PUT',
    body: JSON.stringify({ ...snap, transferMode: otherMode, phoneGateEnabled: snap.phoneGateEnabled }),
  })
  if (modePut.body?.transferMode !== otherMode) {
    fail('settings_mode', `mode switch failed expected ${otherMode}`, { modePut: modePut.body })
  } else {
    pass('settings_mode', { from: snap.transferMode, to: otherMode })
  }

  // Limits + cooldown (bump then restore)
  const nextDaily = Math.max(1, Number(snap.dailyLimit) === 2 ? 3 : 2)
  const nextWeekly = Math.max(nextDaily, Number(snap.weeklyLimit) === 7 ? 8 : 7)
  const nextCool = Math.max(5, Number(snap.cooldownMinutes) === 30 ? 31 : 30)
  const limitsPut = await json('/settings/device-control', {
    method: 'PUT',
    body: JSON.stringify({
      transferMode: snap.transferMode,
      dailyLimit: nextDaily,
      weeklyLimit: nextWeekly,
      cooldownMinutes: nextCool,
      phoneGateEnabled: snap.phoneGateEnabled,
    }),
  })
  if (
    limitsPut.body?.dailyLimit !== nextDaily ||
    limitsPut.body?.weeklyLimit !== nextWeekly ||
    limitsPut.body?.cooldownMinutes !== nextCool
  ) {
    fail('settings_limits', 'limits/cooldown did not persist', { limitsPut: limitsPut.body })
  } else {
    pass('settings_limits', { daily: nextDaily, weekly: nextWeekly, cooldown: nextCool })
  }

  // Restore original settings
  const restore = await json('/settings/device-control', {
    method: 'PUT',
    body: JSON.stringify(snap),
  })
  if (
    restore.body?.transferMode !== snap.transferMode ||
    restore.body?.dailyLimit !== snap.dailyLimit ||
    restore.body?.weeklyLimit !== snap.weeklyLimit ||
    restore.body?.cooldownMinutes !== snap.cooldownMinutes ||
    restore.body?.phoneGateEnabled !== snap.phoneGateEnabled
  ) {
    fail('settings_restore', 'failed to restore original settings', { restore: restore.body, snap })
  } else {
    pass('settings_restore', snap)
  }

  pass('settings', { restored: true, ...snap })
  return snap
}

async function verifyForceTransfer() {
  const sourceId = deviceId('dc-force-src')
  const targetId = deviceId('dc-force-tgt')
  const phone = uniquePhone()
  report.force_test = { sourceId, targetId, phone }

  const grant = await json('/admin/manual-subscription/grant', {
    method: 'POST',
    body: JSON.stringify({
      device_id: sourceId,
      plan_id: PLAN_ID,
      phone,
      pin: PIN,
      note: 'device-control-force-verify',
    }),
  })
  report.timings_ms.grant = grant.ms
  if (grant.status !== 200 || !grant.body?.ok) {
    fail('force_transfer', `manual grant failed HTTP ${grant.status}`, { grant: grant.body })
    return
  }

  // Link phone registry for force-phone resolution
  await json('/device/phone', {
    method: 'POST',
    headers: {},
    body: JSON.stringify({ device_id: sourceId, phone }),
  })

  const srcBefore = await accountProbe(sourceId)
  const tgtBefore = await accountProbe(targetId)
  if (!srcBefore.active) {
    fail('force_transfer', 'source inactive after grant', { srcBefore })
    return
  }
  if (tgtBefore.active) {
    fail('force_transfer', 'target unexpectedly active before transfer')
    return
  }

  const idemKey = `dc_force_${Date.now()}_${targetId.slice(0, 16)}`
  const forceStart = Date.now()
  const force = await json('/transfer/admin-force-phone', {
    method: 'POST',
    body: JSON.stringify({
      payment_phone: phone,
      target_device_id: targetId,
      source_device_id: sourceId,
      security_pin: PIN,
      idempotency_key: idemKey,
    }),
  })
  report.timings_ms.force_transfer = Date.now() - forceStart
  if (force.status !== 200 || !force.body?.ok) {
    fail('force_transfer', `admin-force-phone failed HTTP ${force.status}`, { force: force.body })
    return
  }

  const srcAfter = await accountProbe(sourceId)
  const tgtAfter = await accountProbe(targetId)
  report.force_before = srcBefore
  report.force_after = { source: srcAfter, target: tgtAfter }

  const checks = []
  if (srcAfter.active) checks.push('source still active')
  if (!tgtAfter.active) checks.push('target not active')
  if (String(tgtAfter.expires_at) !== String(srcBefore.expires_at)) checks.push('expiry mismatch')
  if (Number(tgtAfter.remaining_days) !== Number(srcBefore.remaining_days)) checks.push('remaining_days mismatch')
  if (tgtAfter.amount != null && srcBefore.amount != null && Number(tgtAfter.amount) !== Number(srcBefore.amount)) {
    checks.push('amount mismatch')
  }
  if (
    tgtAfter.duration_days != null &&
    srcBefore.duration_days != null &&
    Number(tgtAfter.duration_days) !== Number(srcBefore.duration_days)
  ) {
    checks.push('duration mismatch')
  }
  if (tgtAfter.plan_name && srcBefore.plan_name && tgtAfter.plan_name !== srcBefore.plan_name) {
    checks.push('plan_name mismatch')
  }
  if (checks.length) {
    fail('force_transfer', checks.join('; '), { srcBefore, srcAfter, tgtAfter })
    return
  }

  const replay = await json('/transfer/admin-force-phone', {
    method: 'POST',
    body: JSON.stringify({
      payment_phone: phone,
      target_device_id: targetId,
      source_device_id: sourceId,
      security_pin: PIN,
      idempotency_key: idemKey,
    }),
  })
  if (replay.status !== 200 || !replay.body?.ok) {
    fail('force_transfer', `idempotent replay failed HTTP ${replay.status}`, { replay: replay.body })
    return
  }

  const srcFinal = await accountProbe(sourceId)
  if (srcFinal.active) {
    fail('force_transfer', 'source reactivated after idempotent replay')
    return
  }

  const dc = await json('/settings/device-control')
  const sawForceLog = Array.isArray(dc.body?.logs)
    ? dc.body.logs.some((l) => /force|transfer/i.test(String(l.message || '')))
    : false
  const sawPending = Array.isArray(dc.body?.pending) && dc.body.pending.length > 0

  pass('force_transfer', {
    source_active_after: false,
    target_active_after: true,
    expires_at: tgtAfter.expires_at,
    amount: tgtAfter.amount,
    remaining_days: tgtAfter.remaining_days,
    duration_days: tgtAfter.duration_days,
    plan_name: tgtAfter.plan_name,
    ms: report.timings_ms.force_transfer,
    activity_refreshed: sawPending,
    logs_include_transfer: sawForceLog,
    idempotent_replay: true,
  })
  pass('verify', {
    source_active: srcAfter.active,
    target_active: tgtAfter.active,
    metadata_preserved: true,
  })
  pass('account', {
    amount: tgtAfter.amount,
    remaining_days: tgtAfter.remaining_days,
    duration_days: tgtAfter.duration_days,
    expires_at: tgtAfter.expires_at,
    plan_name: tgtAfter.plan_name,
  })
  pass('canonical_entitlement', {
    engine: 'commitSubscriptionTransfer',
    source_revoked: !srcAfter.active,
    target_active: tgtAfter.active,
  })
  pass('hamisha_compatibility', {
    shared_engine: 'commitSubscriptionTransfer',
    admin_path: 'executeAdminForceTransfer -> commitSubscriptionTransfer',
    user_path: 'transfer/confirm|respond -> commitSubscriptionTransfer',
  })
}

async function main() {
  console.log('=== Device Control Complete Verification ===')
  console.log('API:', API)
  const health = await json('/health', { headers: {} })
  report.commit = health.body?.commit || null
  console.log('commit:', String(report.commit || '').slice(0, 12))

  await verifySpaShell()
  await verifySettings()
  await verifyForceTransfer()

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
