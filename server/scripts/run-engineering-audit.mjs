#!/usr/bin/env node
/**
 * Full engineering audit against production VPS (+ Render parity).
 *   ADMIN_TOKEN=3030 node server/scripts/run-engineering-audit.mjs
 *   ADMIN_TOKEN=3030 node server/scripts/run-engineering-audit.mjs --repair
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()
const doRepair = process.argv.includes('--repair')

async function get(base, apiPath) {
  const res = await fetch(`${base}${apiPath}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function post(base, apiPath, payload = {}) {
  const res = await fetch(`${base}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify(payload),
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function health(base) {
  const res = await fetch(`${base}/api/health`, { cache: 'no-store' })
  return res.json().catch(() => ({}))
}

async function main() {
  const report = {
    generated_at: new Date().toISOString(),
    vps: VPS,
    render: RENDER,
    repair_run: doRepair,
    commits: {},
    payment_audit: null,
    subscription_parity: null,
    subscription_repair: null,
    manual_gift: null,
    pass: true,
  }

  const [vpsHealth, renderHealth] = await Promise.all([health(VPS), health(RENDER)])
  report.commits.vps = vpsHealth.commit ?? null
  report.commits.render = renderHealth.commit ?? null
  report.commits.parity = report.commits.vps === report.commits.render

  const payment = await get(VPS, '/api/runtime/payment-production-audit?days=90')
  report.payment_audit = payment.body
  if (payment.status !== 200) report.pass = false

  const parity = await get(VPS, '/api/runtime/subscription-api-parity-audit')
  report.subscription_parity = parity.body
  if (parity.status !== 200) report.pass = false

  const gift = await get(VPS, '/api/runtime/manual-gift-production-investigation')
  report.manual_gift = {
    answers: gift.body?.answers,
    audit_stats: gift.body?.audit_stats,
  }

  if (doRepair) {
    const repairs = []
    for (const step of [
      ['/runtime/subscription-false-expired-repair?dry_run=0&confirm=1', 'false_expired'],
      ['/runtime/subscription-wrong-direction-repair?dry_run=0&confirm=1&limit=25', 'wrong_direction'],
      ['/runtime/subscription-duplicate-phone-repair?dry_run=0&confirm=1', 'duplicate_phone'],
    ]) {
      try {
        const r = await post(VPS, `/api${step[0]}`)
        repairs.push({ step: step[1], ok: r.status === 200, body: r.body })
      } catch (e) {
        repairs.push({ step: step[1], ok: false, error: String(e.message || e) })
        report.pass = false
      }
    }
    report.subscription_repair = repairs
    const after = await get(VPS, '/api/runtime/subscription-api-parity-audit')
    report.subscription_parity_after = after.body
  }

  const outPath = path.join(ROOT, 'docs', 'engineering-audit', 'FINAL_ENGINEERING_REPORT.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  console.log('\nWrote', outPath)
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
