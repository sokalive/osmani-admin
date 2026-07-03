#!/usr/bin/env node
/**
 * Full production stabilization audit (Parts 1–2 + deployment health).
 *
 *   node scripts/production-stabilization-audit.mjs
 *   VPS_API=https://api.osmanitv.com ADMIN_TOKEN=... node scripts/production-stabilization-audit.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '') + '/api'
const RENDER_API =
  String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '') + '/api'
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../../docs/production-stabilization')

async function call(base, method, route, body) {
  const res = await fetch(`${base}${route}`, {
    method,
    headers: {
      'X-Admin-Token': TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${base}${route} HTTP ${res.status}: ${JSON.stringify(json)}`)
  return json
}

async function health(base) {
  const res = await fetch(`${base}/health`, { cache: 'no-store' })
  return res.json().catch(() => ({}))
}

async function main() {
  const startedAt = new Date().toISOString()
  const [vpsHealth, renderHealth] = await Promise.all([health(API), health(RENDER_API)])

  const falseExpiredBefore = await call(API, 'GET', '/runtime/subscription-false-expired-audit')
  let falseExpiredRepair = null
  if (falseExpiredBefore.affected_count > 0) {
    falseExpiredRepair = await call(API, 'POST', '/runtime/subscription-false-expired-repair?dry_run=0&confirm=1')
  }
  const falseExpiredAfter = await call(API, 'GET', '/runtime/subscription-false-expired-audit')

  const incidentBefore = await call(API, 'GET', '/runtime/subscription-incident-audit')
  let incidentRepair = null
  const incidentNeedsRepair =
    (incidentBefore.counts?.incorrectly_suspended_active ?? 0) > 0 ||
    (incidentBefore.counts?.incorrectly_revoked_migration_shadow ?? 0) > 0
  if (incidentNeedsRepair) {
    incidentRepair = await call(API, 'POST', '/runtime/subscription-incident-repair')
  }
  const incidentAfter = await call(API, 'GET', '/runtime/subscription-incident-audit')

  const restorationBefore = await call(API, 'GET', '/runtime/subscription-restoration-audit')
  let restorationRepair = null
  if ((restorationBefore.unresolved_users_count ?? 0) > 0) {
    restorationRepair = await call(API, 'POST', '/runtime/subscription-restoration-repair')
  }
  const restorationAfter = await call(API, 'GET', '/runtime/subscription-restoration-audit')

  const revokedEvidence = {
    legitimate_transfer_sources: falseExpiredBefore.skipped_transfer_sources || [],
    legitimate_transfer_source_count: falseExpiredBefore.skipped_transfer_source_count ?? 0,
    incorrect_false_expired_before: falseExpiredBefore.affected || [],
    incorrect_false_expired_repaired: falseExpiredRepair?.repaired || [],
    incident_suspended_before: incidentBefore.before?.suspended_devices || [],
    incident_shadows_before: incidentBefore.before?.revoked_shadow_devices || [],
    incident_recovered: incidentRepair?.recovered_users || incidentRepair?.recovered || [],
    restoration_unresolved_before: restorationBefore.unresolved_users || [],
    restoration_restored: restorationRepair?.restored_users || [],
  }

  const checks = {
    false_expired_clear: falseExpiredAfter.affected_count === 0,
    incident_clear:
      (incidentAfter.after?.incorrectly_suspended_active ?? 0) === 0 &&
      (incidentAfter.after?.incorrectly_revoked_migration_shadow ?? 0) === 0,
    restoration_clear: (restorationAfter.unresolved_users_count ?? 0) === 0,
    vps_health: Boolean(vpsHealth?.ok ?? vpsHealth?.status === 'ok'),
    render_health: Boolean(renderHealth?.ok ?? renderHealth?.status === 'ok'),
    commit_parity: String(vpsHealth?.commit || '') === String(renderHealth?.commit || ''),
  }
  const subscriptionPass =
    checks.false_expired_clear && checks.incident_clear && checks.restoration_clear
  const deployPass = checks.vps_health && checks.render_health
  const allPass = subscriptionPass && deployPass

  const report = {
    generated_at: startedAt,
    finished_at: new Date().toISOString(),
    environments: {
      vps: { api: API, health: vpsHealth },
      render: { api: RENDER_API, health: renderHealth },
    },
    part1_false_expired: {
      before: falseExpiredBefore,
      repair: falseExpiredRepair,
      after: falseExpiredAfter,
    },
    part2_revoked: {
      before: incidentBefore,
      repair: incidentRepair,
      after: incidentAfter,
      evidence: revokedEvidence,
    },
    restoration: {
      before: restorationBefore,
      repair: restorationRepair,
      after: restorationAfter,
    },
    checks,
    subscription_pass: subscriptionPass,
    deploy_pass: deployPass,
    commit_parity_note: checks.commit_parity
      ? null
      : 'Render deploy hook (RENDER_API_DEPLOY_HOOK) not configured in GitHub — VPS ahead of Render until hook is set and workflow succeeds.',
    overall: allPass ? 'PASS' : 'FAIL',
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, 'report.json')
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2))

  console.log(JSON.stringify({ outPath, checks, overall: report.overall }, null, 2))
  if (!allPass) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
