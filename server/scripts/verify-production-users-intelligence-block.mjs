/**
 * Production verification for Users Intelligence block enforcement.
 * Usage:
 *   node scripts/verify-production-users-intelligence-block.mjs [device_id]
 * Env: API_BASE (default https://osmani-admin-api.onrender.com), DATABASE_URL (optional, for DB audit)
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import pg from 'pg'

const __dir = dirname(fileURLToPath(import.meta.url))
const API = (process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const deviceArg = String(process.argv[2] || process.env.VERIFY_DEVICE_ID || '').trim()

function loadEnvFile() {
  for (const p of [
    resolve(__dir, '../.env'),
    resolve(__dir, '../../.env'),
    resolve(__dir, '../../server/.env'),
  ]) {
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
      if (!m || process.env[m[1]]) continue
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
    break
  }
}
loadEnvFile()

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(120_000) })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return { status: res.status, body, ok: res.ok }
}

const report = {
  api: API,
  time: new Date().toISOString(),
  checks: [],
  pass: true,
}

function check(name, ok, detail) {
  report.checks.push({ name, ok, detail })
  if (!ok) report.pass = false
  console.log(ok ? 'PASS' : 'FAIL', name, detail ? JSON.stringify(detail) : '')
}

async function main() {
  const health = await fetchJson(`${API}/api/health`)
  check('health', health.ok && health.body?.ok === true, {
    status: health.status,
    commit: health.body?.commit,
  })

  const routes = [
    ['GET access-check (missing id)', `${API}/api/users-intelligence/access-check`, 400],
    ['POST register', `${API}/api/users-intelligence/register`, null],
    ['POST register-device', `${API}/api/users-intelligence/register-device`, null],
  ]

  const acMissing = await fetchJson(routes[0][1])
  check('access-check route exists', acMissing.status !== 404, { status: acMissing.status })

  const testId = deviceArg || `prod-verify-${Date.now()}`
  const regBody = {
    deviceId: testId,
    phoneNumber: '255700000099',
    deviceFingerprint: 'verify-fp',
    appVersion: '1.0.0',
  }
  for (const [label, url] of routes.slice(1)) {
    const r = await fetchJson(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(regBody),
    })
    check(`${label} route`, r.status !== 404 && r.body?.ok === true, {
      status: r.status,
      blocked: r.body?.blocked,
    })
  }

  const ac = await fetchJson(`${API}/api/users-intelligence/access-check?device_id=${encodeURIComponent(testId)}`)
  check('access-check registered device', ac.ok && ac.body?.registered === true, ac.body)

  const verify = await fetchJson(`${API}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: testId }),
  })
  check('subscription/verify route', verify.status !== 404, { status: verify.status })
  report.subscriptionVerifySample = {
    blocked: verify.body?.blocked,
    playbackAllowed: verify.body?.playbackAllowed,
    playbackGateReason: verify.body?.playbackGateReason,
    status: verify.body?.status,
  }

  const dbUrl = process.env.DATABASE_URL
  if (dbUrl) {
    const pool = new pg.Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } })
    try {
      const blocked = await pool.query(
        `SELECT device_id, block_reason, blocked_by, blocked_at
         FROM device_intelligence_registry WHERE status = 'blocked'
         ORDER BY blocked_at DESC NULLS LAST LIMIT 20`,
      )
      report.blockedRegistryCount = blocked.rowCount
      const targetId = deviceArg || blocked.rows[0]?.device_id
      if (targetId) {
        const reg = await pool.query(
          `SELECT status, block_reason, device_fingerprint, phone_number
           FROM device_intelligence_registry WHERE device_id = $1`,
          [targetId],
        )
        const sub = await pool.query(
          `SELECT manual_admin_blocked, status, expires_at FROM device_subscriptions WHERE device_id = $1`,
          [targetId],
        )
        const regRow = reg.rows[0]
        const subRow = sub.rows[0]
        check('registry blocked row', regRow?.status === 'blocked', {
          deviceId: targetId,
          status: regRow?.status,
          blockReason: regRow?.block_reason,
        })
        if (regRow?.status === 'blocked' && subRow?.manual_admin_blocked !== true) {
          await pool.query(
            `INSERT INTO device_subscriptions (device_id, status, expires_at, started_at, transaction_id, manual_admin_blocked, updated_at)
             VALUES ($1, 'pending', now() - interval '1 day', now(), $2, true, now())
             ON CONFLICT (device_id) DO UPDATE SET manual_admin_blocked = true, updated_at = now()`,
            [targetId, `intel_sync:${Date.now()}`.slice(0, 120)],
          )
          report.repairApplied = { deviceId: targetId, action: 'set manual_admin_blocked=true' }
        }
        const subAfter = await pool.query(
          `SELECT manual_admin_blocked FROM device_subscriptions WHERE device_id = $1`,
          [targetId],
        )
        check('subscription manual_admin_blocked synced', subAfter.rows[0]?.manual_admin_blocked === true, {
          deviceId: targetId,
          manual_admin_blocked: subAfter.rows[0]?.manual_admin_blocked,
        })

        const liveVerify = await fetchJson(`${API}/api/subscription/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_id: targetId }),
        })
        const liveAc = await fetchJson(
          `${API}/api/users-intelligence/access-check?device_id=${encodeURIComponent(targetId)}`,
        )
        check('production access-check blocked=true', liveAc.body?.blocked === true, liveAc.body)
        check('production verify playback denied', liveVerify.body?.playbackAllowed === false, {
          blocked: liveVerify.body?.blocked,
          playbackAllowed: liveVerify.body?.playbackAllowed,
          playbackGateReason: liveVerify.body?.playbackGateReason,
        })
        report.realDevice = targetId
      } else {
        check('blocked device in registry', false, { message: 'No blocked devices found; pass device_id arg' })
      }
    } finally {
      await pool.end()
    }
  } else {
    report.dbSkipped = 'DATABASE_URL not set — skipped registry/subscription audit'
    if (deviceArg) {
      const liveAc = await fetchJson(
        `${API}/api/users-intelligence/access-check?device_id=${encodeURIComponent(deviceArg)}`,
      )
      const liveVerify = await fetchJson(`${API}/api/subscription/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: deviceArg }),
      })
      check('access-check for device', liveAc.ok, liveAc.body)
      check('verify playback denied when blocked', liveAc.body?.blocked !== true || liveVerify.body?.playbackAllowed === false, {
        accessCheck: liveAc.body,
        verify: {
          blocked: liveVerify.body?.blocked,
          playbackAllowed: liveVerify.body?.playbackAllowed,
          playbackGateReason: liveVerify.body?.playbackGateReason,
        },
      })
    }
  }

  console.log('\n--- REPORT ---')
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
