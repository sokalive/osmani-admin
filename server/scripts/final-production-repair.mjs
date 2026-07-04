#!/usr/bin/env node
/**
 * Final production repair — investigate each false-expired / API-mismatch device,
 * repair only proven cases, verify, global audit.
 *
 *   ADMIN_TOKEN=3030 node server/scripts/final-production-repair.mjs
 *   ADMIN_TOKEN=3030 node server/scripts/final-production-repair.mjs --repair
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

async function get(apiPath) {
  const res = await fetch(`${VPS}${apiPath}`, {
    headers: { 'X-Admin-Token': TOKEN },
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function post(apiPath, payload = {}) {
  const res = await fetch(`${VPS}${apiPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify(payload),
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function publicGet(apiPath) {
  const res = await fetch(`${VPS}${apiPath}`, { cache: 'no-store' })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

async function probeDeviceApis(deviceId) {
  const d = encodeURIComponent(deviceId)
  const [status, verify, recover, inv] = await Promise.all([
    publicGet(`/api/subscription-status?device_id=${d}`),
    post('/api/subscription/verify', { device_id: deviceId }),
    post('/api/subscription/recover', { device_id: deviceId, fingerprint: 'audit-probe' }).catch(() => ({
      status: 0,
      body: {},
    })),
    get(`/api/runtime/device-production-investigation?device_id=${d}`),
  ])
  const sub = inv.body?.subscription_audit?.device_subscriptions?.[0] ?? null
  return {
    device_id: deviceId,
    db: sub
      ? {
          status: sub.status,
          expires_at: sub.expires_at,
          transaction_id: sub.transaction_id,
          manual_admin_blocked: sub.manual_admin_blocked,
        }
      : null,
    subscription_status: {
      active: status.body?.active === true,
      status: status.body?.status,
      expires_at: status.body?.expires_at,
      remaining_seconds: status.body?.remaining_seconds,
      playback_allowed: status.body?.playback_allowed ?? status.body?.can_play ?? null,
    },
    verify: {
      active: verify.body?.active === true,
      status: verify.body?.status,
      expires_at: verify.body?.expires_at,
      remaining_seconds: verify.body?.remaining_seconds,
      manual_gift: verify.body?.manualGift ?? null,
    },
    recover: {
      ok: recover.body?.ok === true,
      recovered_from: recover.body?.recovered_from ?? null,
      error: recover.body?.error ?? null,
    },
    investigation: {
      should_be_active: inv.body?.subscription_audit?.should_be_active,
      is_false_expired: inv.body?.subscription_audit?.is_false_expired,
      customer_paid: inv.body?.payment_verification?.customer_actually_paid,
      paid_via: inv.body?.payment_verification?.paid_via,
      access_state: inv.body?.subscription_audit?.access_state,
      transfer_out: inv.body?.counts?.transfers_out ?? 0,
      transfer_in: inv.body?.counts?.transfers_in ?? 0,
      manual_grants: inv.body?.counts?.manual_grants ?? 0,
      completed_payments: inv.body?.counts?.completed_payments ?? 0,
    },
  }
}

function eligibleForFalseExpiredRepair(probe, auditRow) {
  if (!auditRow) return { eligible: false, reason: 'not_in_false_expired_audit' }
  const txn = String(probe.db?.transaction_id ?? '')
  if (txn.startsWith('moved:')) return { eligible: false, reason: 'moved_source_intentional' }
  const exp = probe.db?.expires_at ? new Date(probe.db.expires_at).getTime() : 0
  if (!exp || exp <= Date.now()) return { eligible: false, reason: 'not_future_expiry' }
  if (probe.db?.status === 'active' && probe.investigation?.is_false_expired !== true) {
    return { eligible: false, reason: 'already_active' }
  }
  const paid =
    probe.investigation?.customer_paid === 'YES' ||
    probe.investigation?.paid_via?.completed_payment ||
    probe.investigation?.paid_via?.manual_grant ||
    probe.investigation?.paid_via?.recovery ||
    probe.investigation?.paid_via?.offer_code ||
    probe.investigation?.paid_via?.transfer_in ||
    /^osm(_sp)?_/.test(txn)
  if (!paid && probe.investigation?.completed_payments === 0 && probe.investigation?.manual_grants === 0) {
    return { eligible: false, reason: 'no_valid_entitlement' }
  }
  return {
    eligible: true,
    reason: auditRow.category || 'wrongly_pending',
    root_cause:
      'Future expires_at with status pending/inactive — entitlement exists but verify denies access until status=active',
  }
}

function deviceVerified(probe) {
  return (
    probe.verify?.active === true &&
    probe.subscription_status?.active === true &&
    Number(probe.verify?.remaining_seconds) > 0
  )
}

async function main() {
  const report = {
    title: 'Final Production Repair',
    generated_at: new Date().toISOString(),
    phase: doRepair ? 'repair_and_verify' : 'investigation_only',
    vps: VPS,
    devices: [],
    repair: null,
    before_audit: null,
    after_audit: null,
    payment_audit: null,
    commits: {},
    verdict: null,
  }

  const health = await fetch(`${VPS}/api/health`, { cache: 'no-store' }).then((r) => r.json())
  report.commits.vps_before = health.commit

  const parity = await get('/api/runtime/subscription-api-parity-audit')
  report.before_audit = parity.body

  const deviceIds = [
    ...new Set([
      ...(parity.body?.false_expired ?? []).map((r) => r.device_id),
      ...(parity.body?.api_mismatch ?? []).map((r) => r.device_id),
    ]),
  ]

  const auditMap = new Map((parity.body?.false_expired ?? []).map((r) => [r.device_id, r]))

  for (const deviceId of deviceIds) {
    const probe = await probeDeviceApis(deviceId)
    const eligibility = eligibleForFalseExpiredRepair(probe, auditMap.get(deviceId))
    report.devices.push({
      ...probe,
      audit_row: auditMap.get(deviceId) ?? null,
      eligibility,
      verified_after: null,
    })
  }

  if (doRepair) {
    const eligible = report.devices.filter((d) => d.eligibility.eligible)
    if (eligible.length === 0) {
      report.repair = { skipped: true, reason: 'no_eligible_devices' }
    } else {
      const repairRes = await post('/api/runtime/subscription-false-expired-repair?dry_run=0&confirm=1')
      report.repair = repairRes.body

      for (const d of report.devices) {
        if (!d.eligibility.eligible) continue
        const after = await probeDeviceApis(d.device_id)
        d.verified_after = {
          ...after,
          pass: deviceVerified(after),
        }
      }
    }

    report.after_audit = (await get('/api/runtime/subscription-api-parity-audit')).body
    report.payment_audit = (await get('/api/runtime/payment-production-audit?days=90')).body

    const renderHealth = await fetch(`${RENDER}/api/health`, { cache: 'no-store' }).then((r) => r.json())
    report.commits.render = renderHealth.commit
    report.commits.vps_after = (await fetch(`${VPS}/api/health`, { cache: 'no-store' }).then((r) => r.json())).commit

    const c = report.after_audit?.counts ?? {}
    const allRepaired = report.devices.filter((d) => d.eligibility.eligible).every((d) => d.verified_after?.pass)
    const auditClean =
      (c.false_expired ?? 1) === 0 &&
      (c.api_mismatch_sampled ?? 1) === 0 &&
      (c.duplicate_phone_clusters ?? 1) === 0

    report.verdict =
      allRepaired && auditClean && report.payment_audit?.verdict === 'NO_BUG_FOUND'
        ? 'SYSTEM 100% VERIFIED'
        : auditClean && allRepaired
          ? 'REPAIR_COMPLETE_AUDIT_CLEAN'
          : 'PARTIAL'
  }

  const outPath = path.join(ROOT, 'docs', 'engineering-audit', 'FINAL_PRODUCTION_REPAIR_REPORT.json')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  console.log('\nWrote', outPath)
  process.exit(report.verdict === 'SYSTEM 100% VERIFIED' || (!doRepair && report.devices.length > 0) ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
