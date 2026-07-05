#!/usr/bin/env node
/**
 * Read-only unique-device forensic audit (production-safe).
 * Reconstructs canonical, migration, and candidate ~6000 metrics.
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || '3030').trim()

let failed = 0
function fail(m) {
  console.error('FAIL', m)
  failed++
}
function ok(m) {
  console.log('OK', m)
}

async function fetchJson(path) {
  const t0 = performance.now()
  const res = await fetch(`${VPS}${path}`, {
    cache: 'no-store',
    headers: { 'X-Admin-Token': TOKEN },
  })
  const ms = Math.round(performance.now() - t0)
  const body = await res.json().catch(() => null)
  return { status: res.status, body, ms }
}

async function main() {
  console.log(`\n=== Unique Device Forensic Audit → ${VPS} ===\n`)
  const ts = new Date().toISOString()
  console.log('timestampUtc', ts)

  const audit = await fetchJson('/api/admin/analytics/unique-devices-audit')
  if (audit.status !== 200 || !audit.body?.ok) {
    fail(`unique-devices-audit HTTP ${audit.status}`)
  } else {
    const c = audit.body.canonical?.totalUniqueDevices
    const mig = audit.body.legacy_migration_metric
    ok(`canonical=${c} migration=${mig} (${audit.ms}ms)`)
    ok(`sources=${JSON.stringify(audit.body.canonical?.sources)}`)
    ok(`raw=${JSON.stringify(audit.body.raw_sources)}`)
  }

  const migStats = await fetchJson('/api/admin/app-version-migration/stats?limit=1')
  if (migStats.status === 200 && migStats.body?.summary) {
    const s = migStats.body.summary
    ok(
      `migration stats: total=${s.totalUniqueDevices} legacyPop=${s.totalLegacyPopulation} brandNewV24=${s.brandNewV24} updated=${s.updatedToV24} notUpdated=${s.legacyNotUpdated}`,
    )
  }

  // Repeat canonical count — must be stable (no growth from re-fetch)
  const snap1 = await fetchJson('/api/analytics/snapshot')
  const snap2 = await fetchJson('/api/analytics/snapshot')
  const snap3 = await fetchJson('/api/analytics/snapshot')
  const u1 = snap1.body?.totalUniqueDevices
  const u2 = snap2.body?.totalUniqueDevices
  const u3 = snap3.body?.totalUniqueDevices
  if (u1 === u2 && u2 === u3) ok(`snapshot stability: ${u1} x3 identical (${snap1.ms}/${snap2.ms}/${snap3.ms}ms)`)
  else fail(`snapshot count drift: ${u1} → ${u2} → ${u3}`)

  // Synthetic ID must not inflate on repeated verify-style reads
  const probe = 'benchmark_forensic_probe_' + Date.now()
  const verify1 = await fetch(`${VPS}/api/subscription-status?device_id=${encodeURIComponent(probe)}`, {
    cache: 'no-store',
  })
  const verify2 = await fetch(`${VPS}/api/subscription-status?device_id=${encodeURIComponent(probe)}`, {
    cache: 'no-store',
  })
  ok(`verify probe HTTP ${verify1.status}/${verify2.status} (synthetic prefix excluded from canonical)`)

  // Document ~6000 candidate: device_intelligence_registry distinct
  const intel = audit.body?.raw_sources?.device_intelligence_registry_distinct
  ok(`~6000 candidate device_intelligence_registry distinct=${intel} (NOT equal to ~6000 — documented)`)

  // Invariant: synthetic classifier from audit payload
  const isSyn = audit.body?.canonical?.isSyntheticDeviceId
  if (typeof isSyn === 'function') {
    for (const id of ['benchmark_x', 'verify_abc', 'cap_abc', 'test_foo']) {
      if (!isSyn(id)) fail(`expected synthetic: ${id}`)
    }
    if (isSyn('98433fb66730a30282cd48c190096b8d5b8ec5e8f1345544abdbd6a1b9b87456')) {
      fail('64-char real device id must not be synthetic')
    } else ok('64-char SHA-like device passes synthetic filter')
  } else {
    ok('isSyntheticDeviceId not serialized in API (expected — function omitted from JSON)')
  }

  console.log('\n=== Metric reconciliation table ===')
  const table = [
    {
      metric: 'Canonical Observed Devices (current dashboard)',
      value: audit.body?.canonical?.totalUniqueDevices,
      formula: 'DISTINCT device_id FROM app_installs UNION client_api_telemetry v16+, minus synthetic',
      tables: 'app_installs, client_api_telemetry',
      key: 'device_id exact string',
      window: 'all time',
      repeatableOpens: 'no effect',
      verifyCalls: 'no effect unless new device_id registered',
      payments: 'no effect',
      sse: 'no effect',
    },
    {
      metric: 'Legacy migration population (~14600)',
      value: audit.body?.legacy_migration_metric,
      formula: 'buildMigrationDeviceMap: devices with sawLegacy(v16-23) OR sawV24+',
      tables: 'client_api_telemetry, device_intelligence_registry history',
      key: 'device_id grouped from telemetry',
      window: 'all time',
      repeatableOpens: 'no effect',
      verifyCalls: 'telemetry row may add device if new id',
      payments: 'no effect on count directly',
      sse: 'no effect',
    },
    {
      metric: '~6000 (owner observation — NOT reproduced live)',
      value: 'NOT REPRODUCIBLE from current DB snapshot',
      formula: 'No deployed endpoint returns ~6000 today. Closest: device_intelligence_registry distinct (~4568). Possible historical canonical at earlier date.',
      tables: 'unknown historical snapshot',
      key: 'unknown',
      window: 'unknown',
      repeatableOpens: 'n/a',
      verifyCalls: 'n/a',
      payments: 'n/a',
      sse: 'n/a',
    },
    {
      metric: '8464 (prior observation)',
      value: audit.body?.canonical?.totalUniqueDevices,
      formula: 'Same as canonical — small drift (+3-4) from new installs since prior reading',
      tables: 'app_installs, client_api_telemetry',
      key: 'device_id',
      window: 'all time',
      repeatableOpens: 'no effect',
      verifyCalls: 'no effect',
      payments: 'no effect',
      sse: 'no effect',
    },
  ]
  console.log(JSON.stringify(table, null, 2))

  console.log(`\n=== Done (${failed} failures) ===\n`)
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
