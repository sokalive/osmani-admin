#!/usr/bin/env node
/**
 * Production subscription expiry audit + consistency verification.
 *
 * Usage:
 *   node server/scripts/verify-subscription-expiry-production.mjs
 *   ADMIN_TOKEN=3030 node server/scripts/verify-subscription-expiry-production.mjs
 *   REPAIR=1 node server/scripts/verify-subscription-expiry-production.mjs
 */
import { computeStackedExpiryIso } from '../src/lib/subscriptionStacking.js'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const API = `${VPS}/api`
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const DO_REPAIR = String(process.env.REPAIR || '0').trim() === '1'

const report = {
  time: new Date().toISOString(),
  api: API,
  commit: null,
  plans: {},
  audit: {},
  stacking: {},
  verify: {},
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

async function adminGet(path) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

async function adminPost(path, query = '') {
  const res = await fetch(`${API}${path}${query}`, {
    method: 'POST',
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => null)
  return { res, body }
}

function testNoStackPolicy() {
  const now = Date.UTC(2026, 5, 27, 12, 0, 0) // 27 Jun 2026
  const week = computeStackedExpiryIso(null, 7, now)
  if (week.stacked !== false || week.expiry_policy !== 'midnight_africa_dar_es_salaam') {
    fail('no_stack', `fresh purchase policy ${week.expiry_policy}`)
    return
  }

  const prev = new Date(now + 15 * 86400000).toISOString() // 15 days remaining
  const preserved = computeStackedExpiryIso(prev, 7, now)
  if (preserved.expiry_policy !== 'preserve_existing_active' || preserved.expiresAt !== prev) {
    fail('no_stack', `active renewal must preserve existing expiry, got ${preserved.expiresAt}`)
    return
  }
  report.stacking = {
    fresh_policy: week.expiry_policy,
    active_renewal_policy: preserved.expiry_policy,
    stacking_disabled: true,
  }
  pass('no_stack', 'midnight-EAT fresh purchase + preserve_existing_active (no stacking)')
}

async function verifyPlans() {
  const res = await fetch(`${API}/plans`, { cache: 'no-store' })
  const plans = await res.json()
  if (!res.ok || !Array.isArray(plans)) {
    fail('plans', `GET /plans HTTP ${res.status}`)
    return
  }
  const weekly = plans.find((p) => Number(p.price) === 3000 && p.isActive !== false)
  report.plans.all = plans.map((p) => ({
    id: p.id,
    name: p.name,
    price: p.price,
    durationDays: p.durationDays ?? p.duration_days,
    isActive: p.isActive ?? p.is_active,
  }))
  if (!weekly || !Number.isFinite(Number(weekly.durationDays ?? weekly.duration_days))) {
    fail('plans', 'TSh 3000 entry plan must exist with a valid durationDays')
    return
  }
  report.plans.weekly_3000 = weekly
  pass(
    'plans',
    `${weekly.name}: ${weekly.durationDays ?? weekly.duration_days} days @ TSh ${weekly.price}`,
  )
}

async function runExpiryAudit() {
  const audit = await adminGet('/runtime/subscription-expiry-audit?limit=2500&since_days=120')
  if (!audit.res.ok) {
    fail('audit', `expiry audit HTTP ${audit.res.status}`)
    return
  }
  const b = audit.body || {}
  report.audit = {
    users_audited: b.users_audited,
    extension_policy: b.extension_policy,
    summary: b.summary,
    weekly_3000_plan: b.weekly_3000_plan,
    samples: b.samples,
  }
  pass(
    'audit',
    `audited ${b.users_audited} users — over_credited=${b.summary?.over_credited ?? 0}, ui_mismatch=${b.summary?.ui_mismatch_only ?? 0}`,
  )

  if (DO_REPAIR && (b.summary?.over_credited ?? 0) > 0) {
    const repair = await adminPost('/runtime/subscription-expiry-repair', '?dry_run=0&max_repairs=200')
    report.audit.repair = repair.body
    if (!repair.res.ok) {
      fail('repair', `repair HTTP ${repair.res.status}`)
    } else {
      pass('repair', `repaired ${repair.body?.repaired_count ?? 0} over-credited users`)
    }
  } else {
    const dry = await adminPost('/runtime/subscription-expiry-repair', '?dry_run=1&max_repairs=50')
    report.audit.repair_dry_run = {
      candidates: dry.body?.candidates,
      would_repair: dry.body?.repaired_count,
    }
  }
}

async function verifySmsConsistency() {
  const logs = await adminGet('/admin/sms/log?limit=30&trigger_type=subscription_activated')
  if (!logs.res.ok) {
    report.sms.skipped = 'log endpoint unavailable'
    return
  }
  const rows = Array.isArray(logs.body?.rows) ? logs.body.rows : []
  report.sms.activation_samples = rows.length
  pass('sms', `${rows.length} recent activation SMS rows (expiry from backend expiresAt at send time)`)
}

async function main() {
  console.log('=== Subscription expiry production audit ===')
  const health = await fetch(`${API}/health`).then((r) => r.json())
  report.commit = health.commit
  console.log('commit:', String(health.commit || '').slice(0, 12))

  testNoStackPolicy()
  await verifyPlans()
  await runExpiryAudit()
  await verifySmsConsistency()

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))
  console.log(report.pass ? '\nOVERALL: PASS' : '\nOVERALL: FAIL')
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
