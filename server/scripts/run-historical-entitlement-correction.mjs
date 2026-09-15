#!/usr/bin/env node
/**
 * Historical entitlement correction CLI (dry-run default).
 *
 *   node server/scripts/run-historical-entitlement-correction.mjs
 *   node server/scripts/run-historical-entitlement-correction.mjs --apply --confirm
 *   PRODUCTION_API=https://api.osmanitv.com ADMIN_TOKEN=3030 node server/scripts/run-historical-entitlement-correction.mjs --remote
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const args = new Set(process.argv.slice(2))
const apply = args.has('--apply')
const confirm = args.has('--confirm')
const remote = args.has('--remote')
const deviceArg = process.argv.find((a) => a.startsWith('--device='))
const deviceId = deviceArg ? deviceArg.slice('--device='.length).trim() : null

const API = String(process.env.PRODUCTION_API || process.env.VPS_API || 'https://api.osmanitv.com').replace(
  /\/$/,
  '',
)
const TOKEN = String(process.env.ADMIN_TOKEN || process.env.ADMIN_API_TOKEN || '3030').trim()

async function runRemote() {
  const headers = { 'X-Admin-Token': TOKEN, Accept: 'application/json' }
  if (!apply) {
    const url = `${API}/api/runtime/historical-entitlement-correction-audit${deviceId ? `?device_id=${encodeURIComponent(deviceId)}` : ''}`
    const res = await fetch(url, { headers, cache: 'no-store' })
    const body = await res.json()
    console.log(JSON.stringify(body, null, 2))
    if (!res.ok || body.ok === false) process.exit(1)
    return
  }
  const qs = new URLSearchParams({
    dry_run: confirm ? '0' : '1',
    confirm: confirm ? '1' : '0',
    max_repairs: '500',
  })
  if (deviceId) qs.set('device_id', deviceId)
  const res = await fetch(`${API}/api/runtime/historical-entitlement-correction-apply?${qs}`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: confirm ? 1 : 0 }),
  })
  const body = await res.json()
  console.log(JSON.stringify(body, null, 2))
  if (!res.ok || body.ok === false) process.exit(1)
}

async function runLocal() {
  const mod = await import('../src/lib/historicalEntitlementCorrection.js')
  if (!apply) {
    const report = await mod.auditHistoricalEntitlementCorrection({ deviceId })
    console.log(JSON.stringify(report, null, 2))
    return
  }
  const report = await mod.applyHistoricalEntitlementCorrection({
    dryRun: !confirm,
    confirm,
    deviceId,
  })
  console.log(JSON.stringify(report, null, 2))
}

try {
  if (remote || !process.env.DATABASE_URL) {
    if (!process.env.DATABASE_URL && !remote) {
      console.warn('DATABASE_URL not set — using remote API', API)
    }
    await runRemote()
  } else {
    await runLocal()
  }
} catch (e) {
  console.error(e)
  process.exit(1)
}
