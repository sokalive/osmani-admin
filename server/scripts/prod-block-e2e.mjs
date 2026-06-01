/**
 * End-to-end production block test (requires DATABASE_URL in server/.env or ../.env).
 */
import crypto from 'node:crypto'
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dir = dirname(fileURLToPath(import.meta.url))
const API = (process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

for (const p of [resolve(__dir, '../.env'), resolve(__dir, '../../.env')]) {
  if (!existsSync(p)) continue
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  break
}

const dbUrl = process.env.DATABASE_URL
if (!dbUrl) {
  console.error('DATABASE_URL required in .env for E2E block test')
  process.exit(2)
}

const deviceId = `e2e-block-${Date.now()}`

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(120_000) })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })

try {
  await fetchJson(`${API}/api/users-intelligence/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId, phoneNumber: '255711111111', appVersion: '9.0.0' }),
  })

  const ins = await pool.query(
    `INSERT INTO device_intelligence_registry (
      account_id, user_id, device_id, phone_number, status, block_reason, blocked_by, blocked_at
    ) VALUES ($1,$2,$3,$1,'blocked','E2E production test','e2e-script',now())
    ON CONFLICT (device_id) DO UPDATE SET status='blocked', block_reason='E2E production test', blocked_at=now()
    RETURNING id`,
    ['255711111111', crypto.randomUUID(), deviceId],
  )

  await pool.query(
    `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, manual_admin_blocked, updated_at)
     VALUES ($1,'active', now() + interval '30 days', now(), $2, true, now())
     ON CONFLICT (device_id) DO UPDATE SET manual_admin_blocked = true, updated_at = now()`,
    [deviceId, `e2e:${Date.now()}`.slice(0, 120)],
  )

  const ac = await fetchJson(
    `${API}/api/users-intelligence/access-check?device_id=${encodeURIComponent(deviceId)}`,
  )
  const verify = await fetchJson(`${API}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  })

  const ok =
    ac.body?.blocked === true &&
    verify.body?.blocked === true &&
    verify.body?.playbackAllowed === false &&
    verify.body?.playbackGateReason === 'blocked_device'

  console.log(
    JSON.stringify(
      {
        ok,
        deviceId,
        registryId: ins.rows[0]?.id,
        accessCheck: ac.body,
        verify: {
          blocked: verify.body?.blocked,
          playbackAllowed: verify.body?.playbackAllowed,
          playbackGateReason: verify.body?.playbackGateReason,
        },
      },
      null,
      2,
    ),
  )

  await pool.query(
    `UPDATE device_intelligence_registry SET status='active', block_reason='', blocked_at=NULL WHERE device_id=$1`,
    [deviceId],
  )
  await pool.query(`UPDATE device_subscriptions SET manual_admin_blocked=false WHERE device_id=$1`, [deviceId])

  process.exit(ok ? 0 : 1)
} finally {
  await pool.end()
}
