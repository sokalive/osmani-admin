#!/usr/bin/env node
/**
 * Post-incident verification for subscription expiry repair + restore.
 *
 *   node server/scripts/verify-subscription-expiry-incident.mjs
 *   DEVICE_ID=c172c09cedb35d39 node server/scripts/verify-subscription-expiry-incident.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const API = `${VPS}/api`
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const DEVICE_ID = String(process.env.DEVICE_ID || 'c172c09cedb35d39').trim()

const report = {
  time: new Date().toISOString(),
  api: API,
  commit: null,
  device_id: DEVICE_ID,
  before: {},
  after: {},
  restore_audit: {},
  pass: true,
}

function fail(msg) {
  report.pass = false
  console.error('FAIL', msg)
}

async function adminGet(path) {
  const res = await fetch(`${API}${path}`, { headers: { 'X-Admin-Token': TOKEN }, cache: 'no-store' })
  return { res, body: await res.json().catch(() => null) }
}

async function adminPost(path, query = '', body = null) {
  const res = await fetch(`${API}${path}${query}`, {
    method: 'POST',
    headers: { 'X-Admin-Token': TOKEN, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  return { res, body: await res.json().catch(() => null) }
}

async function subStatus(deviceId) {
  const res = await fetch(`${API}/subscription-status?device_id=${encodeURIComponent(deviceId)}`, {
    cache: 'no-store',
  })
  return res.json()
}

async function subVerify(deviceId) {
  const res = await fetch(`${API}/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
    cache: 'no-store',
  })
  return res.json()
}

async function main() {
  const health = await fetch(`${API}/health`).then((r) => r.json())
  report.commit = health.commit
  console.log('commit:', String(health.commit || '').slice(0, 12))

  report.before.status = await subStatus(DEVICE_ID)
  report.before.verify = await subVerify(DEVICE_ID)

  const audit = await adminGet(`/runtime/subscription-expiry-restore-audit?since_days=30&device_id=${DEVICE_ID}`)
  report.restore_audit = audit.body
  if (!audit.res.ok) fail(`restore-audit HTTP ${audit.res.status}`)

  const expiryAudit = await adminGet('/runtime/subscription-expiry-audit?limit=10&device_id=' + DEVICE_ID)
  report.expiry_audit = expiryAudit.body?.categories ?? expiryAudit.body

  report.after.status = await subStatus(DEVICE_ID)
  report.after.verify = await subVerify(DEVICE_ID)

  const active =
    report.after.status?.active === true &&
    report.after.verify?.active === true &&
    new Date(report.after.status?.expiresAt || 0).getTime() > Date.now()

  if (!active) {
    fail(`device ${DEVICE_ID} not active on subscription-status/verify`)
  } else {
    console.log('PASS device active until', report.after.status.expiresAt)
  }

  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
