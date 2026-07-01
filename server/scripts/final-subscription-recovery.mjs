#!/usr/bin/env node
/**
 * Final production subscription recovery orchestrator.
 *
 *   cd server && node scripts/final-subscription-recovery.mjs
 *
 * Env: VPS_API, RENDER_API, ADMIN_TOKEN
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const args = new Set(process.argv.slice(2))
const shadowOnly = args.has('--shadow-only')

async function call(base, method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: {
      'X-Admin-Token': TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${base} ${method} ${path} HTTP ${res.status}: ${JSON.stringify(json)}`)
  return json
}

async function health(base) {
  try {
    const res = await fetch(`${base}/api/health`, { cache: 'no-store' })
    return res.json()
  } catch (e) {
    return { ok: false, error: String(e.message || e) }
  }
}

async function shadowBatch(base, shadowLimit = 25) {
  return call(base, 'POST', `/runtime/subscription-shadow-repair-batch?shadow_limit=${shadowLimit}&orphan_limit=10`)
}

async function runShadowUntilZero(base) {
  const rounds = []
  for (let i = 0; i < 60; i++) {
    const batch = await shadowBatch(base, 25)
    rounds.push({
      round: i + 1,
      migrated: batch.migrated?.length ?? 0,
      failed: batch.failed?.length ?? 0,
      remaining: batch.remaining_unique_shadows,
      shadows: batch.after?.shadows,
      commit: batch.commit,
    })
    console.log(
      `[${base}] round ${i + 1}: migrated=${rounds.at(-1).migrated} failed=${rounds.at(-1).failed} remaining=${rounds.at(-1).remaining} shadows=${rounds.at(-1).shadows}`,
    )
    if ((batch.remaining_unique_shadows ?? 0) === 0 && (batch.after?.shadows ?? 0) === 0) {
      return { ok: true, rounds, last: batch }
    }
    if ((batch.migrated?.length ?? 0) === 0 && (batch.orphans_finalized?.length ?? 0) === 0) break
  }
  const last = rounds.length ? await shadowBatch(base, 25) : null
  return {
    ok: (last?.remaining_unique_shadows ?? 1) === 0 && (last?.after?.shadows ?? 1) === 0,
    rounds,
    last,
  }
}

async function main() {
  const report = {
    started_at: new Date().toISOString(),
    vps: await health(VPS),
    render: await health(RENDER),
    false_expired: null,
    incident: null,
    shadow_repair: null,
    restoration: null,
    final_audit: null,
  }

  console.log('VPS commit', report.vps.commit)
  console.log('Render commit', report.render.commit)

  report.false_expired = await call(VPS, 'GET', '/runtime/subscription-false-expired-audit')
  console.log('false_expired_affected', report.false_expired.affected_count)

  try {
    report.wrong_direction_before = await call(VPS, 'GET', '/runtime/subscription-wrong-direction-audit')
    console.log('wrong_direction_victims', report.wrong_direction_before.victims_count)
  } catch (e) {
    console.warn('wrong_direction audit not available yet:', e.message)
  }

  if (report.false_expired.affected_count > 0) {
    const dry = await call(VPS, 'POST', '/runtime/subscription-false-expired-repair?dry_run=1')
    console.log('false_expired_would_repair', dry.repaired_count)
    report.false_expired_repair = await call(
      VPS,
      'POST',
      '/runtime/subscription-false-expired-repair?dry_run=0&confirm=1',
    )
    console.log('false_expired_repaired', report.false_expired_repair.repaired_count)
  }

  try {
    const wdDry = await call(VPS, 'POST', '/runtime/subscription-wrong-direction-repair?dry_run=1')
    console.log('wrong_direction_would_repair', wdDry.repaired_count)
    for (let i = 0; i < 20; i++) {
      const wd = await call(VPS, 'POST', '/runtime/subscription-wrong-direction-repair?dry_run=0&confirm=1&limit=25')
      console.log(
        `wrong_direction round ${i + 1}: repaired=${wd.repaired_count} remaining=${wd.remaining_victims}`,
      )
      report.wrong_direction_repair = wd
      if ((wd.remaining_victims ?? 0) === 0) break
      if ((wd.repaired_count ?? 0) === 0) break
    }
  } catch (e) {
    console.warn('wrong_direction repair skipped:', e.message)
  }

  if (!shadowOnly) {
    try {
      report.incident = await call(VPS, 'POST', '/runtime/subscription-incident-repair')
      console.log('incident', report.incident.counts)
    } catch (e) {
      console.warn('incident repair skipped:', e.message)
    }
  }

  report.shadow_repair = await runShadowUntilZero(VPS)

  if (!shadowOnly) {
    try {
      report.restoration = await call(VPS, 'POST', '/runtime/subscription-restoration-repair?limit=30')
      console.log(
        'restoration restored',
        report.restoration.restored_users_count,
        'unresolved',
        report.restoration.unresolved_users_count,
      )
    } catch (e) {
      console.warn('restoration repair skipped:', e.message)
    }

    if ((report.restoration?.unresolved_users_count ?? 0) > 0) {
      for (let i = 0; i < 5; i++) {
        try {
          const r = await call(VPS, 'POST', '/runtime/subscription-restoration-repair?limit=30')
          console.log(`restoration round ${i + 2}: restored=${r.restored_users_count} unresolved=${r.unresolved_users_count}`)
          report.restoration = r
          if ((r.unresolved_users_count ?? 0) === 0) break
        } catch (e) {
          break
        }
      }
    }
  }

  report.final_audit = {
    false_expired: await call(VPS, 'GET', '/runtime/subscription-false-expired-audit'),
    wrong_direction: await call(VPS, 'GET', '/runtime/subscription-wrong-direction-audit').catch(() => null),
    incident: await call(VPS, 'GET', '/runtime/subscription-incident-audit'),
    shadow_batch: await shadowBatch(VPS, 1),
  }

  const counts = report.final_audit.incident?.counts || {}
  report.summary = {
    false_expired_remaining: report.final_audit.false_expired.affected_count ?? -1,
    wrong_direction_remaining: report.final_audit.wrong_direction?.victims_count ?? -1,
    migration_shadows_remaining: counts.incorrectly_revoked_migration_shadow ?? -1,
    restoration_unresolved: counts.restoration_unresolved ?? report.restoration?.unresolved_users_count ?? -1,
    active_subs: counts.active_subscriptions ?? -1,
    shadow_unique_remaining: report.final_audit.shadow_batch.remaining_unique_shadows ?? -1,
  }

  report.pass =
    report.summary.false_expired_remaining === 0 &&
    (report.summary.wrong_direction_remaining ?? 0) === 0 &&
    report.summary.migration_shadows_remaining === 0 &&
    report.summary.shadow_unique_remaining === 0

  report.finished_at = new Date().toISOString()
  console.log('\n=== FINAL SUMMARY ===')
  console.log(JSON.stringify(report.summary, null, 2))
  console.log('PASS', report.pass)

  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
