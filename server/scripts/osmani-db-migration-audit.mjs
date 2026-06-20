/**
 * osmani-db migration feasibility audit — evidence collector.
 * No writes. Read-only queries + Render API metadata.
 *
 * Required (at least one):
 *   DATABASE_URL          direct Postgres (internal or external URL)
 *   RENDER_API_KEY        for Render plan/disk metrics when DATABASE_URL unset
 *
 * Optional:
 *   RENDER_OWNER_ID
 *   RENDER_BILLING_SNAPSHOT_JSON or server/scripts/billing-snapshot.json
 *
 * Usage:
 *   $env:DATABASE_URL = "postgresql://..."   # from Render → osmani-db → Connect (external)
 *   $env:RENDER_API_KEY = "rnd_..."
 *   cd server && node scripts/osmani-db-migration-audit.mjs
 */
import pg from 'pg'
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const { Pool } = pg
const DB_URL = String(process.env.DATABASE_URL || '').trim()
const RENDER_KEY = String(process.env.RENDER_API_KEY || '').trim()
const DB_NAME = 'osmani-db'

async function renderFetch(path, params = {}) {
  const url = new URL(`https://api.render.com/v1${path}`)
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '') continue
    url.searchParams.set(k, String(v))
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${RENDER_KEY}`, Accept: 'application/json' },
  })
  const text = await res.text()
  const json = JSON.parse(text)
  if (!res.ok) throw new Error(`Render ${path} ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}

function unwrap(row) {
  return row?.postgres || row?.service || row?.envVar || row
}

function loadBillingSnapshot() {
  const raw = process.env.RENDER_BILLING_SNAPSHOT_JSON || ''
  if (raw.trim()) return JSON.parse(raw)
  const p = join(__dir, 'billing-snapshot.json')
  if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'))
  return null
}

function poolFromUrl(url) {
  const isLocal = /localhost|127\.0\.0\.1/i.test(url) || process.env.PGSSLMODE === 'disable'
  return new Pool({
    connectionString: url,
    max: 2,
    connectionTimeoutMillis: 15_000,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  })
}

async function queryRenderPostgresMeta() {
  if (!RENDER_KEY) return { available: false, reason: 'RENDER_API_KEY not set' }
  const page = await renderFetch('/postgres', { limit: 100, name: DB_NAME })
  const rows = (Array.isArray(page) ? page : []).map(unwrap)
  const pg = rows.find((p) => String(p.name) === DB_NAME)
  if (!pg) return { available: false, reason: `${DB_NAME} not found in workspace` }

  const plan = String(pg.plan || pg.serviceDetails?.plan || '').toLowerCase()
  const ram = pg.ram || pg.serviceDetails?.ram || null
  const diskGb = Number(pg.diskSizeGB || pg.serviceDetails?.diskSizeGB || 0) || null
  const region = pg.region || null

  let diskUsedMb = null
  try {
    const end = new Date().toISOString()
    const start = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString()
    const m = await renderFetch('/metrics/disk-usage', {
      resource: [pg.id],
      startTime: start,
      endTime: end,
    })
    for (const row of m?.data || []) {
      for (const v of row.values || []) {
        diskUsedMb = Math.max(diskUsedMb || 0, Number(v.value) || 0)
      }
    }
  } catch (e) {
    diskUsedMb = { error: String(e.message) }
  }

  let connections = null
  try {
    const end = new Date().toISOString()
    const start = new Date(Date.now() - 24 * 3600 * 1000).toISOString()
    const m = await renderFetch('/metrics/active-connections', {
      resource: [pg.id],
      startTime: start,
      endTime: end,
    })
    let maxConn = 0
    for (const row of m?.data || []) {
      for (const v of row.values || []) {
        maxConn = Math.max(maxConn, Number(v.value) || 0)
      }
    }
    connections = { max_24h: maxConn }
  } catch (e) {
    connections = { error: String(e.message) }
  }

  const services = await renderFetch('/services', { limit: 100 })
  const svcList = (Array.isArray(services) ? services : []).map(unwrap)
  const linked = []
  for (const svc of svcList) {
    try {
      const envPage = await renderFetch(`/services/${svc.id}/env-vars`, { limit: 100 })
      const envRows = (Array.isArray(envPage) ? envPage : []).map(unwrap)
      const dbUrl = envRows.find((e) => e.key === 'DATABASE_URL')?.value || ''
      if (!dbUrl) continue
      const host = new URL(dbUrl).hostname.toLowerCase()
      const pgHost = String(pg.databaseName || pg.name || '').toLowerCase()
      if (
        host.includes('osmani') ||
        host.includes(String(pg.id).slice(0, 8)) ||
        dbUrl.includes(DB_NAME)
      ) {
        linked.push({ service: svc.name, id: svc.id, db_host: host })
      }
    } catch {
      /* skip */
    }
  }

  return {
    available: true,
    postgres_id: pg.id,
    name: pg.name,
    region,
    plan,
    ram,
    disk_provisioned_gb: diskGb,
    disk_used_mb_metrics_7d_peak: diskUsedMb,
    connections_24h: connections,
    status: pg.status,
    suspended: pg.suspended,
    linked_services_inferred: linked,
    dashboard_urls: {
      info: `https://dashboard.render.com/postgres/${pg.id}`,
      metrics: `https://dashboard.render.com/postgres/${pg.id}/metrics`,
    },
  }
}

async function queryLiveDatabase() {
  if (!DB_URL) return { available: false, reason: 'DATABASE_URL not set' }
  const pool = poolFromUrl(DB_URL)
  try {
    const version = await pool.query('SELECT version()')
    const dbSize = await pool.query(
      `SELECT pg_size_pretty(pg_database_size(current_database())) AS size,
              pg_database_size(current_database()) AS size_bytes`,
    )
    const tableCount = await pool.query(
      `SELECT count(*)::int AS n
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    )
    const largest = await pool.query(
      `SELECT relname AS table_name,
              pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
              pg_total_relation_size(c.oid) AS total_bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relkind = 'r'
       ORDER BY pg_total_relation_size(c.oid) DESC
       LIMIT 15`,
    )
    const rowCounts = await pool.query(
      `SELECT relname AS table_name, n_live_tup::bigint AS est_rows
       FROM pg_stat_user_tables
       ORDER BY n_live_tup DESC NULLS LAST
       LIMIT 15`,
    )
    const extensions = await pool.query(
      `SELECT extname, extversion FROM pg_extension ORDER BY extname`,
    )
    const connections = await pool.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE application_name <> '')::int AS named
       FROM pg_stat_activity
       WHERE datname = current_database()`,
    )
    const fp = (() => {
      try {
        const u = new URL(DB_URL)
        return {
          host: u.hostname,
          port: u.port || '5432',
          database: u.pathname.replace(/^\//, '').split('/')[0],
        }
      } catch {
        return { parseError: true }
      }
    })()

    return {
      available: true,
      fingerprint: fp,
      postgres_version: version.rows[0]?.version,
      database_size: dbSize.rows[0],
      table_count_public: tableCount.rows[0]?.n,
      largest_tables_by_disk: largest.rows,
      largest_tables_by_est_rows: rowCounts.rows,
      extensions: extensions.rows,
      active_connections: connections.rows[0],
    }
  } finally {
    await pool.end()
  }
}

async function main() {
  const billing = loadBillingSnapshot()
  const renderMeta = await queryRenderPostgresMeta()
  const liveDb = await queryLiveDatabase()

  const codeSchema = {
    source: 'server/src/db/*.js + billingTables.js (CREATE TABLE IF NOT EXISTS at startup)',
    required_extension: 'pgcrypto (gen_random_uuid)',
    estimated_distinct_tables: 32,
    table_names_from_code: [
      'channels',
      'banners',
      'app_settings',
      'device_trial_entitlements',
      'app_installs',
      'live_sessions',
      'analytics_reset_challenges',
      'notifications',
      'plans',
      'transactions',
      'device_subscriptions',
      'transfer_codes',
      'device_transfers',
      'security_events',
      'admin_devices',
      'device_security_profiles',
      'admin_otp_codes',
      'subscriptions',
      'zenopay_settings',
      'sonicpesa_settings',
      'checkout_payment_settings',
      'manual_subscription_grants',
      'manual_subscription_admin_pin',
      'offer_codes',
      'offer_code_device_attempts',
      'admin_panel_users',
      'admin_panel_trusted_devices',
      'admin_panel_login_otps',
      'payment_providers',
    ],
    not_used: ['PostGIS', 'LISTEN/NOTIFY', 'logical replication in app code'],
  }

  const report = {
    generated_at: new Date().toISOString(),
    audit_type: 'read_only',
    evidence_status: {
      render_dashboard_api: renderMeta.available ? 'OK' : renderMeta.reason,
      live_database_sql: liveDb.available ? 'OK' : liveDb.reason,
      billing_snapshot: billing ? 'OK' : 'missing — paste Dashboard → Billing into billing-snapshot.json',
    },
    '1_render_osmani_db_plan_and_cost': {
      render_api: renderMeta,
      billing_snapshot: billing,
      note: 'Exact monthly $ only from Dashboard Billing or billing-snapshot.json',
    },
    '2_actual_database_size': liveDb.available
      ? liveDb.database_size
      : { unverified: 'Set DATABASE_URL and re-run' },
    '3_tables_and_largest': liveDb.available
      ? {
          table_count: liveDb.table_count_public,
          largest_by_disk: liveDb.largest_tables_by_disk,
          largest_by_est_rows: liveDb.largest_tables_by_est_rows,
        }
      : { code_estimate: codeSchema },
    '4_production_services_using_osmani_db': renderMeta.linked_services_inferred || {
      unverified: 'Run with RENDER_API_KEY or confirm Dashboard → osmani-db → connected services',
    },
    '5_migration_targets_feasibility': {
      note: 'Code-level feasibility; latency/cost need your Render region + target region',
      vps_postgresql: {
        feasible: true,
        blockers: ['You manage backups, upgrades, firewall, SSL cert'],
        app_changes: 'DATABASE_URL only; ssl rejectUnauthorized:false already used',
        extensions: 'Enable pgcrypto',
      },
      supabase: {
        feasible: true,
        blockers: [
          'Use connection pooler URL for Render (PgBouncer port 6543) if connection limits hit',
          'Free tier 500MB cap — verify size first',
        ],
        app_changes: 'DATABASE_URL; enable pgcrypto in SQL editor if needed',
      },
      neon: {
        feasible: true,
        blockers: [
          'Use pooled connection string for serverless-style limits',
          'Avoid scale-to-zero on production branch',
        ],
        app_changes: 'DATABASE_URL with sslmode=require',
      },
    },
    code_schema_summary: codeSchema,
    live_db_detail: liveDb.available ? liveDb : undefined,
  }

  console.log(JSON.stringify(report, null, 2))
}

main().catch((e) => {
  console.error(JSON.stringify({ error: String(e.message || e) }, null, 2))
  process.exit(1)
})
