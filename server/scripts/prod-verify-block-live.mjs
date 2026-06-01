/**
 * Live production block verification via admin API + subscription verify.
 * Env: ADMIN_LEGACY_TOKEN or X_ADMIN_TOKEN (from .env), API_BASE optional.
 */
import { readFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dir = dirname(fileURLToPath(import.meta.url))
const API = (process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

for (const p of [resolve(__dir, '../.env'), resolve(__dir, '../../.env')]) {
  if (!existsSync(p)) continue
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/)
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
}

const token =
  process.env.ADMIN_LEGACY_TOKEN ||
  process.env.X_ADMIN_TOKEN ||
  process.env.VITE_ADMIN_TOKEN ||
  process.env.ADMIN_TOKEN ||
  ''

const headers = { 'Content-Type': 'application/json', ...(token ? { 'X-Admin-Token': token } : {}) }

async function j(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { ...headers, ...opts.headers },
    signal: AbortSignal.timeout(120_000),
  })
  const body = await res.json().catch(() => null)
  return { status: res.status, body }
}

const deviceId = `live-block-${Date.now()}`

const health = await j(`${API}/api/health`)
console.log('health commit:', health.body?.commit)

await j(`${API}/api/users-intelligence/register`, {
  method: 'POST',
  body: JSON.stringify({ deviceId, phoneNumber: '255722222222', appVersion: '1.0.0' }),
})

const sync = await j(`${API}/api/admin/users-intelligence/sync-blocks`, { method: 'POST', body: '{}' })
console.log('sync-blocks:', sync.status, sync.body)

const list = await j(`${API}/api/admin/users-intelligence?limit=5`)
console.log('admin list:', list.status, list.body?.items?.length ?? 'n/a')

let registryId = null
const blockedExisting = list.body?.items?.find((x) => x.status === 'blocked')
if (blockedExisting) {
  registryId = blockedExisting.id
  console.log('using existing blocked device:', blockedExisting.deviceId)
} else if (list.status === 200 && list.body?.items?.length) {
  registryId = list.body.items[0].id
}

if (!registryId && list.status === 401) {
  console.error('Admin auth required — set ADMIN_LEGACY_TOKEN in .env')
  process.exit(2)
}

if (!registryId) {
  console.error('No registry row to test')
  process.exit(1)
}

const targetDevice =
  blockedExisting?.deviceId || list.body.items.find((x) => x.id === registryId)?.deviceId || deviceId

if (!blockedExisting) {
  const block = await j(`${API}/api/admin/users-intelligence/${registryId}/block`, {
    method: 'POST',
    body: JSON.stringify({ reason: 'Production live verification block' }),
  })
  console.log('block:', block.status, block.body?.registry?.status)
}

const ac = await j(`${API}/api/users-intelligence/access-check?device_id=${encodeURIComponent(targetDevice)}`)
const verify = await j(`${API}/api/subscription/verify`, {
  method: 'POST',
  body: JSON.stringify({ device_id: targetDevice }),
})

const ok =
  ac.body?.blocked === true &&
  verify.body?.blocked === true &&
  verify.body?.playbackAllowed === false

console.log(
  JSON.stringify(
    {
      ok,
      targetDevice,
      accessCheck: ac.body,
      verify: {
        blocked: verify.body?.blocked,
        playbackAllowed: verify.body?.playbackAllowed,
        playbackGateReason: verify.body?.playbackGateReason,
        blockReason: verify.body?.blockReason,
      },
    },
    null,
    2,
  ),
)

if (!blockedExisting && registryId) {
  await j(`${API}/api/admin/users-intelligence/${registryId}/unblock`, {
    method: 'POST',
    body: JSON.stringify({ note: 'cleanup after live verify' }),
  })
  console.log('unblocked test device')
}

process.exit(ok ? 0 : 1)
