#!/usr/bin/env node
/**
 * Read-only entitlement snapshot + compare harness (NO mutation).
 * Capture before deploy: node server/scripts/verify-entitlement-immutability.mjs --capture before.json
 * Compare after deploy: node server/scripts/verify-entitlement-immutability.mjs --compare before.json
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const API = process.env.PRODUCTION_API || 'https://api.osmanitv.com'
const TOKEN = process.env.ADMIN_TOKEN || '3030'

const args = process.argv.slice(2)
const capturePath = args.includes('--capture')
  ? args[args.indexOf('--capture') + 1]
  : args.includes('--compare')
    ? args[args.indexOf('--compare') + 1]
    : null
const isCompare = args.includes('--compare')

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers, cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function productionMetrics() {
  const health = await fetchJson(`${API}/api/health`)
  const cutover = await fetchJson(`${API}/api/runtime/cutover-status`)
  const summary = await fetchJson(`${API}/api/users/summary`, { 'X-Admin-Token': TOKEN })
  return {
    api: API,
    capturedAt: new Date().toISOString(),
    health: health.body,
    cutover: cutover.body,
    usersSummary: summary.body?.summary ?? summary.body,
    pool: health.body?.pool ?? null,
    commit: health.body?.commit ?? cutover.body?.commit ?? null,
    database: cutover.body?.database ?? health.body?.database ?? null,
  }
}

async function snapshotSubscriptionsFromDb() {
  if (!process.env.DATABASE_URL) {
    return { source: 'api_skip', rows: [], note: 'DATABASE_URL not set — DB row snapshot skipped' }
  }
  const { getPool } = await import('../src/db/pool.js')
  const pool = getPool()
  const client = await pool.connect()
  try {
    await client.query('BEGIN READ ONLY')
    const counts = await client.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'active' AND expires_at > now())::int AS active_now,
        COUNT(*) FILTER (WHERE transaction_id LIKE 'moved:%')::int AS moved_markers
      FROM device_subscriptions
    `)
    const { rows } = await client.query(`
      SELECT
        ds.device_id,
        ds.status,
        ds.transaction_id,
        ds.started_at,
        ds.expires_at,
        ds.admin_revoked_at,
        ds.fingerprint_hash,
        ds.manual_admin_blocked,
        ir.phone_number,
        ir.android_id,
        ai.install_instance_id
      FROM device_subscriptions ds
      LEFT JOIN device_intelligence_registry ir ON ir.device_id = ds.device_id
      LEFT JOIN LATERAL (
        SELECT install_instance_id
        FROM app_installs
        WHERE device_id = ds.device_id
        ORDER BY last_seen_at DESC NULLS LAST
        LIMIT 1
      ) ai ON true
      ORDER BY ds.device_id
    `)
    await client.query('ROLLBACK')
    return {
      source: 'database',
      counts: counts.rows[0],
      rows: rows.map((r) => ({
        device_id: String(r.device_id),
        status: String(r.status),
        transaction_id: String(r.transaction_id),
        started_at: r.started_at instanceof Date ? r.started_at.toISOString() : r.started_at,
        expires_at: r.expires_at instanceof Date ? r.expires_at.toISOString() : r.expires_at,
        admin_revoked_at: r.admin_revoked_at instanceof Date ? r.admin_revoked_at.toISOString() : r.admin_revoked_at,
        fingerprint_hash: r.fingerprint_hash ?? null,
        manual_admin_blocked: r.manual_admin_blocked === true,
        phone_number: r.phone_number ?? null,
        android_id: r.android_id ?? null,
        install_instance_id: r.install_instance_id ?? null,
      })),
    }
  } finally {
    client.release()
    await pool.end().catch(() => {})
  }
}

function rowFingerprint(rows) {
  const canonical = rows
    .map((r) => `${r.device_id}|${r.status}|${r.transaction_id}|${r.expires_at}|${r.admin_revoked_at ?? ''}`)
    .join('\n')
  return createHash('sha256').update(canonical).digest('hex')
}

function compareSnapshots(before, after) {
  const diffs = []
  const bMap = new Map((before.subscriptions?.rows ?? []).map((r) => [r.device_id, r]))
  const aMap = new Map((after.subscriptions?.rows ?? []).map((r) => [r.device_id, r]))

  for (const [id, br] of bMap) {
    const ar = aMap.get(id)
    if (!ar) {
      diffs.push({ type: 'deleted', device_id: id, before: br })
      continue
    }
    for (const key of ['status', 'transaction_id', 'expires_at', 'admin_revoked_at']) {
      const bv = br[key] ?? null
      const av = ar[key] ?? null
      if (String(bv) !== String(av)) {
        diffs.push({ type: 'changed', device_id: id, field: key, before: bv, after: av })
      }
    }
  }
  for (const [id, ar] of aMap) {
    if (!bMap.has(id)) diffs.push({ type: 'inserted', device_id: id, after: ar })
  }

  return {
    pass: diffs.length === 0,
    beforeHash: before.subscriptions?.fingerprint ?? null,
    afterHash: after.subscriptions?.fingerprint ?? null,
    beforeCount: before.subscriptions?.rows?.length ?? 0,
    afterCount: after.subscriptions?.rows?.length ?? 0,
    diffs,
  }
}

async function main() {
  const metrics = await productionMetrics()
  const subs = await snapshotSubscriptionsFromDb()
  const snapshot = {
    ...metrics,
    subscriptions: {
      ...subs,
      fingerprint: subs.rows?.length ? rowFingerprint(subs.rows) : null,
    },
  }

  if (!capturePath) {
    console.log(JSON.stringify(snapshot, null, 2))
    return
  }

  const outFile = path.isAbsolute(capturePath) ? capturePath : path.join(process.cwd(), capturePath)

  if (isCompare) {
    if (!existsSync(outFile)) {
      console.error(`Before snapshot not found: ${outFile}`)
      process.exit(1)
    }
    const before = JSON.parse(readFileSync(outFile, 'utf8'))
    const result = compareSnapshots(before, snapshot)
    console.log(JSON.stringify({ compare: result, after: { commit: snapshot.commit, counts: snapshot.subscriptions?.counts } }, null, 2))
    process.exit(result.pass ? 0 : 2)
  }

  writeFileSync(outFile, JSON.stringify(snapshot, null, 2))
  console.log(JSON.stringify({ ok: true, written: outFile, counts: snapshot.subscriptions?.counts, fingerprint: snapshot.subscriptions?.fingerprint }, null, 2))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
