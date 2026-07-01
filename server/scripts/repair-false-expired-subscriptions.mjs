#!/usr/bin/env node
/**
 * Production audit + repair for false-expired subscriptions.
 *
 *   node scripts/repair-false-expired-subscriptions.mjs --audit
 *   node scripts/repair-false-expired-subscriptions.mjs --repair
 *   node scripts/repair-false-expired-subscriptions.mjs --full
 */
const API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '') + '/api'
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()
const args = new Set(process.argv.slice(2))
const doAudit = args.has('--audit') || args.has('--full') || args.size === 0
const doRepair = args.has('--repair') || args.has('--full')
const doRestore = args.has('--full')
const doIncident = args.has('--full')

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'X-Admin-Token': TOKEN,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`${method} ${path} HTTP ${res.status}: ${JSON.stringify(json)}`)
  return json
}

async function subStatus(deviceId) {
  const res = await fetch(`${API}/subscription-status?device_id=${encodeURIComponent(deviceId)}`, {
    cache: 'no-store',
  })
  return res.json()
}

async function main() {
  const health = await call('GET', '/health')
  console.log('commit', health.commit)
  console.log('server', API)

  let audit = null
  if (doAudit) {
    audit = await call('GET', '/runtime/subscription-false-expired-audit')
    console.log('\n=== FALSE EXPIRED AUDIT ===')
    console.log('affected_count', audit.affected_count)
    console.log('skipped_transfer_sources', audit.skipped_transfer_source_count)
    console.log('db_timezone', audit.database_timezone)
    console.log('root_cause', audit.root_cause)
    console.log('samples', JSON.stringify((audit.affected || []).slice(0, 8), null, 2))
  }

  if (doIncident) {
    console.log('\n=== INCIDENT REPAIR ===')
    const inc = await call('POST', '/runtime/subscription-incident-repair')
    console.log('incident ok', inc.ok, 'counts', inc.counts)
  }

  if (doRestore) {
    console.log('\n=== RESTORATION REPAIR ===')
    const rest = await call('POST', '/runtime/subscription-restoration-repair')
    console.log('restoration unresolved', rest.unresolved_users_count, 'restored', rest.restored_users_count)
  }

  let repair = null
  if (doRepair) {
    console.log('\n=== FALSE EXPIRED REPAIR (dry run) ===')
    const dry = await call('POST', '/runtime/subscription-false-expired-repair?dry_run=1')
    console.log('would_repair', dry.repaired_count)

    console.log('\n=== FALSE EXPIRED REPAIR (apply) ===')
    repair = await call('POST', '/runtime/subscription-false-expired-repair?dry_run=0&confirm=1')
    console.log('repaired', repair.repaired_count, 'remaining', repair.affected_count_after)
  }

  if (repair?.repaired?.length) {
    console.log('\n=== POST-REPAIR SPOT CHECKS ===')
    for (const row of repair.repaired.filter((r) => r.ok).slice(0, 5)) {
      const st = await subStatus(row.device_id)
      console.log(row.device_id.slice(0, 16), 'api active', st.active, 'expires', st.expiresAt || st.expires_at)
    }
  }

  const finalAudit = await call('GET', '/runtime/subscription-false-expired-audit')
  const pass = finalAudit.affected_count === 0
  console.log('\n=== FINAL ===')
  console.log('affected_remaining', finalAudit.affected_count)
  console.log(pass ? 'OVERALL: PASS' : 'OVERALL: FAIL')
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
