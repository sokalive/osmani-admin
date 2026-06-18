/**
 * Safely transfer an active subscription to a new device_id by payment phone.
 * Uses existing admin API — no direct DB writes from this script.
 *
 *   ADMIN_TOKEN=3030 node scripts/restore-subscription-by-phone.mjs \
 *     --phone 255678089174 --target b874581a7c265864
 */
const args = process.argv.slice(2)
function getArg(name) {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? String(args[i + 1] || '').trim() : ''
}

const phone = getArg('phone')
const target = getArg('target')
const API_BASE = String(process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030'

if (!phone || !target) {
  console.error('Usage: node scripts/restore-subscription-by-phone.mjs --phone <msisdn> --target <device_id>')
  process.exit(1)
}

const before = await fetch(`${API_BASE}/api/subscription-status?device_id=${encodeURIComponent(target)}`, {
  cache: 'no-store',
}).then((r) => r.json())

const transfer = await fetch(`${API_BASE}/api/transfer/admin-force-phone`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Admin-Token': ADMIN_TOKEN,
  },
  body: JSON.stringify({
    payment_phone: phone,
    target_device_id: target,
  }),
})
const transferBody = await transfer.json().catch(() => null)

const after = await fetch(`${API_BASE}/api/subscription-status?device_id=${encodeURIComponent(target)}`, {
  cache: 'no-store',
}).then((r) => r.json())

const report = {
  phone,
  target_device_id: target,
  before_active: before?.active === true,
  transfer_status: transfer.status,
  transfer: transferBody,
  after_active: after?.active === true,
  after_status: after?.status ?? null,
  after_expires_at: after?.expires_at ?? null,
}
console.log(JSON.stringify(report, null, 2))
if (!report.after_active) process.exit(1)
