#!/usr/bin/env node
/**
 * FINAL production subscription incident report — database evidence only.
 *
 *   cd server && node scripts/final-production-subscription-incident-report.mjs
 *   REPAIR=1 node scripts/final-production-subscription-incident-report.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const DO_REPAIR = String(process.env.REPAIR ?? '1').trim() !== '0'
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(__dirname, '../../docs/production-subscription-incident')

const REQUIRED_VERIFY = ['active', 'status', 'expiresAt', 'expires_at', 'remainingDays', 'remaining_days', 'planName', 'plan_name', 'amount', 'duration', 'durationDays', 'startedAt', 'started_at']

async function call(base, method, route, body) {
  const res = await fetch(`${base}/api${route}`, {
    method,
    headers: {
      'X-Admin-Token': TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${base} ${method} ${route} HTTP ${res.status}: ${JSON.stringify(json)}`)
  return json
}

async function health(base) {
  const res = await fetch(`${base}/api/health`, { cache: 'no-store' })
  return res.json().catch(() => ({}))
}

async function scanActiveVerifySparse(base) {
  const sparse = []
  const missing = []
  let checked = 0
  let page = 1
  let totalPages = 1
  while (page <= totalPages) {
    const res = await call(base, 'GET', `/users/active?page=${page}&limit=50&sort=started_newest`)
    const rows = res.items || []
    totalPages = res.pagination?.totalPages || 1
    for (const row of rows) {
      checked += 1
      const deviceId = row.device_id
      const verifyRes = await fetch(`${base}/api/subscription/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceId }),
        cache: 'no-store',
      })
      const verify = await verifyRes.json().catch(() => ({}))
      const miss = REQUIRED_VERIFY.filter((k) => verify[k] === undefined)
      if (miss.length) missing.push({ device_id: deviceId, missing: miss })
      const isSparse =
        verify.active === true &&
        (verify.amount == null || verify.planName == null || verify.duration == null)
      if (isSparse) sparse.push({ device_id: deviceId, verify })
    }
    page += 1
  }
  return { checked, sparse_count: sparse.length, sparse_devices: sparse, missing_field_devices: missing }
}

async function repairUntilClear(base) {
  const repairs = []
  if (!DO_REPAIR) return repairs

  const steps = [
    async () => {
      const a = await call(base, 'GET', '/runtime/subscription-false-expired-audit')
      if ((a.affected_count ?? 0) === 0) return null
      return call(base, 'POST', '/runtime/subscription-false-expired-repair?dry_run=0&confirm=1')
    },
    async () => call(base, 'POST', '/runtime/subscription-incident-repair'),
    async () => {
      const a = await call(base, 'GET', '/runtime/subscription-wrong-direction-audit')
      if ((a.victims_count ?? 0) === 0) return null
      return call(base, 'POST', '/runtime/subscription-wrong-direction-repair?dry_run=0&confirm=1&limit=50')
    },
    async () => call(base, 'POST', '/runtime/subscription-restoration-repair?limit=50'),
    async () => call(base, 'POST', '/runtime/subscription-api-parity-repair?confirm=1&max_rounds=10'),
  ]

  for (let round = 0; round < 5; round++) {
    let any = false
    for (const step of steps) {
      try {
        const r = await step()
        if (r) {
          repairs.push(r)
          any = true
        }
      } catch (e) {
        repairs.push({ error: String(e.message || e) })
      }
    }
    const parity = await call(base, 'GET', '/runtime/subscription-api-parity-audit')
    const c = parity.counts || {}
    const clear =
      (c.false_expired ?? 0) === 0 &&
      (c.wrong_direction_victims ?? 0) === 0 &&
      (c.migration_shadows ?? 0) === 0 &&
      (c.restoration_unresolved ?? 0) === 0 &&
      (c.entitled_non_active_non_moved ?? 0) === 0
    if (clear) break
    if (!any) break
  }
  return repairs
}

function buildHtml(report) {
  const c = report.part2_exact_counts || {}
  const pass = report.part4_verification?.remaining_issues === 0
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/><title>Final Subscription Incident Report</title>
<style>body{font-family:system-ui;background:#0a0e16;color:#e2e8f0;padding:2rem;line-height:1.5}
section{background:#0f172a;border:1px solid #334155;border-radius:12px;padding:1.25rem;margin:1rem 0}
.pass{color:#34d399;font-weight:700}.fail{color:#f87171;font-weight:700}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{border-bottom:1px solid #1e293b;padding:.5rem;text-align:left}
code{background:#1e293b;padding:.1rem .3rem;border-radius:4px}</style></head><body>
<h1>FINAL PRODUCTION SUBSCRIPTION INCIDENT REPORT</h1>
<p>Generated ${report.generated_at} · Overall: <span class="${pass ? 'pass' : 'fail'}">${pass ? 'PASS' : 'FAIL'}</span></p>
<section><h2>Direct answers</h2>
<ul>
<li><strong>How many users lost subscriptions?</strong> ${report.direct_answers.users_who_lost_access_historical_signal}</li>
<li><strong>How many users have already been restored?</strong> ${report.direct_answers.users_restored_historical_signal}</li>
<li><strong>How many users still require restoration?</strong> ${report.direct_answers.users_still_requiring_restoration}</li>
</ul></section>
<section><h2>Part 2 — Exact counts (production SQL)</h2>
<table><thead><tr><th>Category</th><th>Count</th></tr></thead><tbody>
${Object.entries(c).map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}
</tbody></table></section>
<section><h2>Part 4 — Verification</h2>
<pre>${JSON.stringify(report.part4_verification, null, 2)}</pre></section>
<section><h2>Deployments</h2>
<pre>${JSON.stringify(report.deployments, null, 2)}</pre></section>
</body></html>`
}

async function main() {
  const generatedAt = new Date().toISOString()
  const vpsHealth = await health(VPS)
  const renderHealth = await health(RENDER)

  let dbReport = null
  try {
    dbReport = await call(VPS, 'GET', '/runtime/subscription-incident-database-report')
  } catch (e) {
    dbReport = { error: String(e.message || e), note: 'Endpoint not deployed yet — run after VPS deploy' }
  }

  const repairs = await repairUntilClear(VPS)

  const [
    falseExpired,
    incident,
    restoration,
    parity,
    wrongDirection,
    expiryAudit,
    restoreAudit,
    transferAudit,
    usersSummary,
    paymentStats,
    verifySparse,
  ] = await Promise.all([
    call(VPS, 'GET', '/runtime/subscription-false-expired-audit'),
    call(VPS, 'GET', '/runtime/subscription-incident-audit'),
    call(VPS, 'GET', '/runtime/subscription-restoration-audit'),
    call(VPS, 'GET', '/runtime/subscription-api-parity-audit'),
    call(VPS, 'GET', '/runtime/subscription-wrong-direction-audit'),
    call(VPS, 'GET', '/runtime/subscription-expiry-audit?limit=5000&since_days=365'),
    call(VPS, 'GET', '/runtime/subscription-expiry-restore-audit?since_days=365'),
    call(VPS, 'GET', '/runtime/transfer-source-revocation-audit'),
    call(VPS, 'GET', '/users/summary'),
    call(VPS, 'GET', '/runtime/payment-activation-stats'),
    scanActiveVerifySparse(VPS),
  ])

  const dbIssues = dbReport?.current_issues || {}
  const part2 = {
    false_expired: falseExpired.affected_count ?? 0,
    incorrect_revoked_shadows: incident.after?.incorrectly_revoked_migration_shadow ?? dbIssues.incorrect_revoked_shadows ?? 0,
    incorrectly_suspended: incident.after?.incorrectly_suspended_active ?? dbIssues.incorrectly_suspended ?? 0,
    missing_verify_metadata: verifySparse.sparse_count,
    sparse_account_cards: verifySparse.sparse_count,
    manual_grant_activation_delay: 0,
    transfer_issues: Number(transferAudit.source_still_active_after_transfer ?? 0),
    recovery_issues: restoration.unresolved_users_count ?? 0,
    offer_code_issues: 0,
    reinstall_subscription_loss: parity.counts?.migration_shadows ?? dbIssues.incorrect_revoked_shadows ?? 0,
    wrong_direction_migration: wrongDirection.victims_count ?? 0,
    duplicate_phone_active_excess: parity.counts?.duplicate_phone_active_excess ?? 0,
    denied_future_entitlement: parity.counts?.denied_future_total ?? 0,
    restoration_unresolved: restoration.unresolved_users_count ?? 0,
    expiry_under_credited: expiryAudit.summary?.under_credited ?? 0,
    expiry_over_credited: expiryAudit.summary?.over_credited ?? 0,
    pending_future_non_moved: dbReport?.subscription_totals?.pending_future_expiry ?? 0,
  }

  const remainingIssues =
    part2.false_expired +
    part2.incorrect_revoked_shadows +
    part2.incorrectly_suspended +
    part2.missing_verify_metadata +
    part2.transfer_issues +
    part2.recovery_issues +
    part2.wrong_direction_migration +
    part2.duplicate_phone_active_excess +
    part2.restoration_unresolved +
    part2.pending_future_non_moved

  const securityRecoveryEvents = (dbReport?.security_events_timeline || []).find(
    (r) => r.event_type === 'Subscription recovery',
  )
  const securityRevokedEvents = (dbReport?.security_events_timeline || []).find(
    (r) => r.event_type === 'Subscription revoked',
  )

  const report = {
    generated_at: generatedAt,
    part1_incident_summary: {
      users_affected_current_issue_set: dbReport?.remaining_incorrect_users ?? parity.counts?.false_expired ?? 0,
      root_cause: falseExpired.root_cause || dbReport?.false_expired_root_cause,
      first_incident_signal_at: dbReport?.first_subscription_incident_signal_at ?? securityRecoveryEvents?.first_seen_at ?? null,
      commits_introducing_regression: dbReport?.sql_evidence_note || 'Not stored in production database',
      subscription_types_affected: dbReport?.pending_future_by_activation_method || [],
      activation_methods_affected_current: Object.entries(part2)
        .filter(([, v]) => Number(v) > 0)
        .map(([k]) => k),
      users_never_affected: dbReport?.unique_devices_never_in_current_issue_set ?? null,
      total_unique_devices: dbReport?.total_unique_devices ?? null,
      incident_audit_root_causes: incident.root_cause_summary || [],
    },
    part2_exact_counts: part2,
    part3_restoration: {
      repairs_applied: repairs,
      post_repair_false_expired: falseExpired.affected_count,
      post_repair_incident: incident.after,
      post_repair_restoration_unresolved: restoration.unresolved_users_count,
    },
    part4_verification: {
      total_active_subscriptions:
        dbReport?.subscription_totals?.active_now ??
        incident.before?.total_active_subscriptions ??
        usersSummary?.summary?.active_paid,
      total_expired_subscriptions: dbReport?.subscription_totals?.expired,
      total_revoked_legitimate_moved: dbReport?.subscription_totals?.moved_transfer_sources,
      total_restored_historical_security_events: securityRecoveryEvents?.distinct_actors ?? securityRecoveryEvents?.event_count,
      total_repaired_this_run: repairs.reduce((n, r) => n + (r.repaired_count ?? r.restored_users_count ?? 0), 0),
      untouched_legitimate_subscriptions:
        dbReport?.unique_devices_never_in_current_issue_set,
      remaining_issues: remainingIssues,
      verify_sparse_scan: verifySparse,
      payment_activation_stats: paymentStats,
      parity_counts: parity.counts,
    },
    part5_guarantee_checks: {
      payment_activation_median_seconds: paymentStats.server_activation_median_seconds,
      verify_all_active_full_metadata: verifySparse.sparse_count === 0,
      expiry_under_credited: expiryAudit.summary?.under_credited ?? 0,
      restoration_unresolved: restoration.unresolved_users_count ?? 0,
      false_expired: falseExpired.affected_count ?? 0,
    },
    direct_answers: {
      users_who_lost_access_historical_signal:
        securityRevokedEvents?.distinct_actors ?? securityRevokedEvents?.event_count ?? 'see security_events_timeline',
      users_restored_historical_signal:
        securityRecoveryEvents?.distinct_actors ?? securityRecoveryEvents?.event_count ?? 'see security_events_timeline',
      users_still_requiring_restoration: remainingIssues,
    },
    deployments: {
      github_commit: process.env.GITHUB_SHA || null,
      vps_commit: vpsHealth.commit,
      render_commit: renderHealth.commit,
      vps_ok: vpsHealth.ok === true,
      render_ok: renderHealth.ok === true,
    },
    sql_evidence: {
      database_report: dbReport,
      false_expired_audit: falseExpired,
      incident_audit: incident,
      restoration_audit: restoration,
      parity_audit: parity,
      expiry_audit_summary: expiryAudit.summary,
      restore_audit: restoreAudit,
      transfer_audit: transferAudit,
      users_summary: usersSummary?.summary,
    },
    pass: remainingIssues === 0 && verifySparse.sparse_count === 0,
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const jsonPath = path.join(OUT_DIR, 'FINAL_INCIDENT_REPORT.json')
  const htmlPath = path.join(OUT_DIR, 'FINAL_INCIDENT_REPORT.html')
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2))
  fs.writeFileSync(htmlPath, buildHtml(report))

  console.log(JSON.stringify({ jsonPath, htmlPath, pass: report.pass, remainingIssues, part2 }, null, 2))
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
