#!/usr/bin/env node
/**
 * Production manual gift investigation + verify API cross-check.
 *
 * Usage:
 *   node scripts/final-manual-gift-production-investigation.mjs
 *   VPS_API=https://api.osmanitv.com ADMIN_TOKEN=3030 node scripts/final-manual-gift-production-investigation.mjs
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(/\/+$/, '')
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.APP_UPDATE_ADMIN_TOKEN || '3030').trim()
const __dir = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(__dir, '../../docs/manual-gift-popup')

async function fetchJson(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
      ...(opts.headers || {}),
    },
  })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body }
}

async function verifyDevice(base, deviceId) {
  const { body } = await fetchJson(base, '/api/subscription/verify', {
    method: 'POST',
    body: JSON.stringify({ device_id: deviceId }),
  })
  return {
    deviceId,
    active: body?.active === true,
    manualGift: body?.manualGift ?? null,
    transaction_id: body?.transaction_id ?? body?.transactionId ?? null,
  }
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })

  const health = await fetchJson(VPS, '/api/health')
  const inv = await fetchJson(VPS, '/api/runtime/manual-gift-production-investigation')
  if (inv.status !== 200) {
    console.error('Investigation failed', inv.status, inv.body)
    process.exit(1)
  }

  const popupDevices = Array.isArray(inv.body?.popup_devices) ? inv.body.popup_devices : []
  const paymentRows = Array.isArray(inv.body?.payment_subscribers_with_unacked_grants)
    ? inv.body.payment_subscribers_with_unacked_grants
    : []

  const popupVerify = []
  for (const row of popupDevices) {
    popupVerify.push(await verifyDevice(VPS, row.device_id))
  }

  const paymentVerifySample = []
  for (const row of paymentRows.slice(0, 25)) {
    paymentVerifySample.push(await verifyDevice(VPS, row.device_id))
  }

  const paymentPopupWrong = paymentVerifySample.filter((v) => v.manualGift?.showPopup === true)
  const popupMismatch = popupVerify.filter((v) => v.manualGift?.showPopup !== true)

  const renderHealth = await fetchJson(RENDER, '/api/health')

  const report = {
    generated_at: new Date().toISOString(),
    vps_commit: health.body?.commit ?? null,
    render_commit: renderHealth.body?.commit ?? null,
    investigation: inv.body,
    verify_cross_check: {
      popup_devices_checked: popupVerify.length,
      popup_verify_results: popupVerify,
      popup_api_mismatch: popupMismatch,
      payment_sample_checked: paymentVerifySample.length,
      payment_incorrect_popup: paymentPopupWrong,
    },
    pass:
      paymentPopupWrong.length === 0 &&
      popupMismatch.length === 0 &&
      Number(inv.body?.audit_stats?.stale_false_positive_grants ?? 0) === 0,
  }

  writeFileSync(join(OUT_DIR, 'PRODUCTION_INVESTIGATION.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report, null, 2))
  if (!report.pass) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
