/**
 * Verify same-phone migration restore for a known old→new device_id pair.
 *
 *   node scripts/verify-migration-case.mjs c0972049aa5f862e b1f6601e048f60af
 *   API_BASE=http://144.91.117.90 node scripts/verify-migration-case.mjs <old_id> <new_id>
 */
const oldId = String(process.argv[2] || '').trim()
const newId = String(process.argv[3] || '').trim()
if (!oldId || !newId) {
  console.error('Usage: node scripts/verify-migration-case.mjs <old_active_device_id> <new_vps_device_id>')
  process.exit(1)
}

const API_BASE = String(process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const legacyHint = oldId.slice(0, 8)

async function fetchStatus(deviceId, extra = {}) {
  const qs = new URLSearchParams({ device_id: deviceId, ...extra })
  const res = await fetch(`${API_BASE}/api/subscription-status?${qs}`, { cache: 'no-store' })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function postVerify(deviceId, body) {
  const res = await fetch(`${API_BASE}/api/subscription/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: 'null' },
    body: JSON.stringify({ device_id: deviceId, ...body }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function main() {
  console.log(`API: ${API_BASE}`)
  console.log(`Old (Render): ${oldId}`)
  console.log(`New (VPS):    ${newId}\n`)

  const beforeOld = await fetchStatus(oldId)
  const beforeNew = await fetchStatus(newId)
  console.log('--- BEFORE old ---')
  console.log(JSON.stringify(beforeOld.body, null, 2))
  console.log('--- BEFORE new ---')
  console.log(JSON.stringify(beforeNew.body, null, 2))

  const verify = await postVerify(newId, {
    legacy_device_id: legacyHint,
    displayed_account_id: legacyHint.toUpperCase(),
  })
  console.log('\n--- POST verify (legacy hint) ---')
  console.log(JSON.stringify(verify.body, null, 2))

  const afterOld = await fetchStatus(oldId)
  const afterNew = await fetchStatus(newId)
  console.log('\n--- AFTER old ---')
  console.log(JSON.stringify(afterOld.body, null, 2))
  console.log('--- AFTER new ---')
  console.log(JSON.stringify(afterNew.body, null, 2))

  const ok =
    afterNew.body?.active === true &&
    afterNew.body?.amount != null &&
    afterNew.body?.plan_duration_days != null &&
    afterNew.body?.expiresAt != null

  console.log(`\nRESULT: ${ok ? 'PASS' : 'FAIL'}`)
  process.exit(ok ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
