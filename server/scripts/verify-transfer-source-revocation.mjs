#!/usr/bin/env node
/**
 * Verify transfer source revocation on live API hosts.
 * Usage: node server/scripts/verify-transfer-source-revocation.mjs
 */
const VPS = String(process.env.VPS_API_BASE || 'https://api.osmanitv.com/api').replace(/\/$/, '')
const RENDER = String(process.env.RENDER_API_BASE || 'https://osmani-admin-api.onrender.com/api').replace(/\/$/, '')

async function health(base) {
  const res = await fetch(`${base}/health`)
  const body = await res.json().catch(() => ({}))
  return { status: res.status, commit: body?.commit || body?.git_commit || null }
}

async function verifyDevice(base, deviceId, fingerprint = '') {
  const headers = { 'Content-Type': 'application/json', 'x-device-id': deviceId }
  const statusRes = await fetch(`${base}/subscription-status?device_id=${encodeURIComponent(deviceId)}`, { headers })
  const statusBody = await statusRes.json().catch(() => ({}))
  const verifyRes = await fetch(`${base}/subscription/verify`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ device_id: deviceId, fingerprint }),
  })
  const verifyBody = await verifyRes.json().catch(() => ({}))
  return {
    subscription_status: statusBody?.active === true || statusBody?.active_now === true,
    verify_active: verifyBody?.active === true || verifyBody?.active_now === true,
    status_http: statusRes.status,
    verify_http: verifyRes.status,
  }
}

async function main() {
  const sourceId = String(process.env.TRANSFER_TEST_SOURCE_DEVICE_ID || '').trim()
  const targetId = String(process.env.TRANSFER_TEST_TARGET_DEVICE_ID || '').trim()
  const fp = String(process.env.TRANSFER_TEST_FINGERPRINT || '').trim()

  for (const [host, base] of [
    ['VPS', VPS],
    ['Render', RENDER],
  ]) {
    const h = await health(base)
    console.log(`\n[${host}] commit=${h.commit || 'unknown'} health=${h.status}`)
    if (sourceId && targetId) {
      const src = await verifyDevice(base, sourceId, fp)
      const tgt = await verifyDevice(base, targetId, fp)
      const pass = !src.verify_active && !src.subscription_status && tgt.verify_active && tgt.subscription_status
      console.log(`  source ${sourceId.slice(0, 12)}… active=${src.verify_active} status=${src.subscription_status}`)
      console.log(`  target ${targetId.slice(0, 12)}… active=${tgt.verify_active} status=${tgt.subscription_status}`)
      console.log(`  ${pass ? 'PASS' : 'FAIL'} transfer revocation check`)
    } else {
      console.log('  (set TRANSFER_TEST_SOURCE_DEVICE_ID + TRANSFER_TEST_TARGET_DEVICE_ID for live pair test)')
    }
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
