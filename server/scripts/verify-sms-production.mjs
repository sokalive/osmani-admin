#!/usr/bin/env node
/**
 * Production Beem SMS verification — settings, failed-log diagnosis, optional live send.
 *
 * Usage:
 *   node scripts/verify-sms-production.mjs
 *   TEST_SMS_PHONE=2557XXXXXXXX node scripts/verify-sms-production.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = path.dirname(fileURLToPath(import.meta.url))
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const APPROVED_SENDER = 'OSMANITVMAX'
const TEST_PHONE = String(process.env.TEST_SMS_PHONE || '').trim()

const report = { time: new Date().toISOString(), hosts: {}, pass: true }

function fail(msg) {
  report.pass = false
  console.error('FAIL', msg)
}

function pass(msg) {
  console.log('PASS', msg)
}

async function adminGet(base, path) {
  const res = await fetch(`${base}/api${path}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

async function adminPost(base, path, payload = {}) {
  const res = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify(payload),
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

function summarizeFailure(row) {
  const pr = row?.providerResponse || {}
  const nested = pr.data || pr
  return {
    trigger: row?.triggerType,
    errorCode: nested.error_code || nested.code || null,
    message: nested.message || pr.message || pr.error || null,
    field: nested.context?.field || null,
  }
}

async function verifyHost(base, label) {
  console.log(`\n=== ${label} (${base}) ===`)
  const hostReport = { base }

  const health = await fetch(`${base}/api/health`).then((r) => r.json())
  hostReport.commit = health.commit
  console.log('commit:', String(health.commit || '').slice(0, 12))

  const beem = await adminGet(base, '/settings/beem')
  if (!beem.res.ok) {
    fail(`${label}: beem settings HTTP ${beem.res.status}`)
    report.hosts[label] = hostReport
    return
  }

  const b = beem.body || {}
  hostReport.beem = {
    enabled: b.enabled,
    effectiveSenderName: b.effectiveSenderName || b.senderName,
    rawSenderName: b.rawSenderName,
    credentialsReady: b.credentialsReady,
    envOverride: b.envOverrideActive,
  }
  console.log('sender effective:', b.effectiveSenderName || b.senderName)
  console.log('sender raw:', b.rawSenderName)
  console.log('credentialsReady:', b.credentialsReady)

  if (b.effectiveSenderName !== APPROVED_SENDER && b.senderName !== APPROVED_SENDER) {
    fail(`${label}: sender is "${b.effectiveSenderName || b.senderName}" not ${APPROVED_SENDER}`)
  } else {
    pass(`${label}: sender name is ${APPROVED_SENDER}`)
  }

  const test = await adminPost(base, '/settings/beem/test')
  hostReport.test = test.body
  console.log('connectivity test:', test.body?.success, test.body?.message)
  if (test.body?.success !== true) {
    fail(`${label}: Beem connectivity test failed — ${test.body?.message || 'unknown'}`)
  } else if (/HTTP 400/i.test(String(test.body?.message || ''))) {
    fail(`${label}: Beem connectivity test reported HTTP 400 — ${test.body?.message}`)
  } else {
    pass(`${label}: Beem connectivity test passed`)
  }

  const log = await adminGet(base, '/admin/sms/log?limit=10')
  const rows = log.body?.rows || []
  const failed = rows.filter((r) => r.status === 'failed')
  const recentFailures = failed.slice(0, 5).map(summarizeFailure)
  hostReport.recentFailures = recentFailures
  if (recentFailures.length) {
    console.log('recent failed triggers:', recentFailures.map((f) => `${f.trigger}:${f.errorCode || f.message}`).join(', '))
  }

  if (TEST_PHONE && label === 'vps') {
    const send = await adminPost(base, '/admin/sms/send', {
      phone: TEST_PHONE,
      message: `Osmani TV SMS test ${new Date().toISOString().slice(11, 19)} UTC`,
    })
    hostReport.liveSend = send.body
    if (send.body?.ok === true) {
      pass(`${label}: live SMS sent to test phone`)
    } else {
      fail(`${label}: live SMS failed — ${send.body?.error || send.body?.reason || JSON.stringify(send.body)}`)
    }
  }

  report.hosts[label] = hostReport
}

async function main() {
  console.log('Beem SMS production verification')
  await verifyHost(VPS, 'vps')
  await verifyHost(RENDER, 'render')

  const outPath = path.join(__dir, '../../docs/sms-verification/report.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))
  console.log(`\nReport: ${outPath}`)
  console.log(report.pass ? '\nRESULT: PASS' : '\nRESULT: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
