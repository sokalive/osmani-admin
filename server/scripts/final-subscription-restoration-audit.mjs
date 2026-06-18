/**
 * Final subscription restoration audit — live Render + VPS + optional repair.
 *
 *   ADMIN_TOKEN=3030 node scripts/final-subscription-restoration-audit.mjs
 *   ADMIN_TOKEN=3030 REPAIR=1 node scripts/final-subscription-restoration-audit.mjs
 */
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const VPS_API = String(process.env.VPS_API || 'http://144.91.117.90').replace(/\/$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'
const REPAIR = String(process.env.REPAIR ?? '1').trim() !== '0'
const API_BASE = String(process.env.API_BASE || '').replace(/\/$/, '')

async function resolveAuditBase() {
  if (API_BASE) return API_BASE
  for (const base of [RENDER_API, VPS_API]) {
    const res = await fetch(`${base}/api/runtime/subscription-restoration-audit`, {
      headers: { 'X-Admin-Token': ADMIN_TOKEN },
      cache: 'no-store',
    })
    if (res.status !== 404) return base
  }
  return RENDER_API
}

const report = {
  restored_users_count: 0,
  unresolved_users_count: 0,
  payment_activation_average_seconds: null,
  legacy_apk_status: 'PENDING',
  vps_apk_status: 'PENDING',
  total_active_subscriptions: 0,
  affected_users_count: 0,
  evidence: {},
}

async function fetchJson(url, opts = {}) {
  const headers = {
    'X-Admin-Token': ADMIN_TOKEN,
    ...(opts.headers || {}),
  }
  const t0 = Date.now()
  const res = await fetch(url, { cache: 'no-store', ...opts, headers })
  const ms = Date.now() - t0
  const body = await res.json().catch(() => null)
  return { res, body, ms }
}

async function auditHost(label, base) {
  const out = { label, base, checks: [] }
  let failed = 0

  const paths = [
    { name: 'plans', path: '/api/plans', expect: (b) => Array.isArray(b) && b.length > 0 },
    {
      name: 'checkout-providers',
      path: '/api/payments/checkout-providers',
      expect: (b) => b?.ok === true,
    },
    {
      name: 'subscription-status',
      path: '/api/subscription-status?device_id=final-audit-probe',
      expect: (b) => typeof b?.active === 'boolean',
    },
  ]

  for (const spec of paths) {
    const { res, body } = await fetchJson(`${base}${spec.path}`)
    const ok = res.ok && spec.expect(body)
    if (!ok) failed += 1
    out.checks.push({ name: spec.name, ok, status: res.status })
  }

  const payT0 = Date.now()
  const payRes = await fetch(`${base}/api/payments/create-payment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'null' },
    body: JSON.stringify({}),
  })
  const payMs = Date.now() - payT0
  const payOk = payRes.status === 400 || payRes.status === 422
  if (!payOk) failed += 1
  out.checks.push({
    name: 'create-payment-origin-null',
    ok: payOk,
    status: payRes.status,
    ms: payMs,
    detail: payOk ? 'validation (not 500 Network failed)' : 'CORS or server error',
  })

  const verifyRes = await fetch(`${base}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'null' },
    body: JSON.stringify({ device_id: 'final-audit-probe' }),
  })
  const verifyBody = await verifyRes.json().catch(() => null)
  const verifyOk = verifyRes.ok && typeof verifyBody?.active === 'boolean'
  if (!verifyOk) failed += 1
  out.checks.push({ name: 'subscription-verify', ok: verifyOk, status: verifyRes.status })

  out.failed = failed
  out.status = failed === 0 ? 'PASS' : 'FAIL'
  return out
}

async function dbAudit(base, repair) {
  const path = repair
    ? '/api/runtime/subscription-restoration-repair'
    : '/api/runtime/subscription-restoration-audit'
  const { res, body } = await fetchJson(`${base}${path}`, { method: repair ? 'POST' : 'GET' })
  if (res.status === 404 && String(process.env.DATABASE_URL || '').trim()) {
    const { loadProcessEnv } = await import('../src/loadEnv.js')
    loadProcessEnv()
    const { runSubscriptionRestorationAudit } = await import('../src/lib/subscriptionRestorationAudit.js')
    return runSubscriptionRestorationAudit({ repair })
  }
  if (res.status === 404) {
    throw new Error(
      `${path} HTTP 404 — deploy commit a7cad57+ to Render/VPS or set DATABASE_URL for local audit`,
    )
  }
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}

async function paymentStats(base) {
  const { res, body } = await fetchJson(`${base}/api/runtime/payment-activation-stats`)
  if (!res.ok) return null
  return body
}

async function main() {
  console.log('=== FINAL SUBSCRIPTION RESTORATION AUDIT ===\n')

  const auditBase = await resolveAuditBase()
  console.log(`Using API base: ${auditBase}\n`)

  if (REPAIR) {
    console.log('==> Running safe repair...')
    const repaired = await dbAudit(auditBase, true)
    report.restored_users_count = repaired.repairs?.migrations_recovered + repaired.repairs?.activations_finalized || 0
    report.unresolved_users_count = repaired.unresolved_users_count ?? 0
    report.total_active_subscriptions = repaired.total_active_subscriptions ?? 0
    report.affected_users_count = repaired.affected_users_count ?? 0
    report.evidence.repair = repaired
  } else {
    const audit = await dbAudit(auditBase, false)
    report.unresolved_users_count = audit.unresolved_users_count ?? 0
    report.restored_users_count = audit.restored_users_count ?? 0
    report.total_active_subscriptions = audit.total_active_subscriptions ?? 0
    report.affected_users_count = audit.affected_users_count ?? 0
    report.evidence.audit = audit
  }

  const stats = await paymentStats(auditBase)
  report.payment_activation_average_seconds = stats?.payment_activation_average_seconds ?? null
  report.evidence.payment_stats = stats

  const legacy = await auditHost('Legacy APK (Render)', RENDER_API)
  const vps = await auditHost('VPS APK', VPS_API)
  report.legacy_apk_status = legacy.status
  report.vps_apk_status = vps.status
  report.evidence.legacy_apk = legacy
  report.evidence.vps_apk = vps

  const postAudit = await dbAudit(auditBase, false)
  report.unresolved_users_count = postAudit.unresolved_users_count ?? 0
  report.restored_users_count =
    (postAudit.affected_users_count ?? 0) - report.unresolved_users_count
  report.evidence.post_repair_audit = postAudit

  console.log('\n=== SUMMARY ===')
  console.log(JSON.stringify(report, null, 2))

  if (report.unresolved_users_count > 0) {
    console.error(`\nFAIL: unresolved_users_count=${report.unresolved_users_count}`)
    process.exit(1)
  }
  if (legacy.status !== 'PASS' || vps.status !== 'PASS') {
    console.error('\nFAIL: APK verification failed')
    process.exit(1)
  }
  console.log('\nDONE: all users resolved, APK checks PASS')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
