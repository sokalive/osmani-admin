/**
 * Production-safe audit: transactions must not be the ownership SoT.
 * Read-only. NEVER changes entitlements.
 *
 * Usage (VPS):
 *   node scripts/audit-transaction-read-only-ownership.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getPool, closePool } from '../src/db/pool.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(__dirname, '..')

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      if (ent.name === 'node_modules') continue
      walk(p, out)
    } else if (/\.(js|mjs)$/.test(ent.name)) out.push(p)
  }
  return out
}

async function main() {
  const report = {
    ok: true,
    at: new Date().toISOString(),
    policy: 'transactions_read_only_for_ownership',
    findings: {},
    failures: [],
  }

  // Static: no live callers of the refused phone→latest-txn helper.
  const offenders = []
  for (const f of walk(path.join(root, 'src'))) {
    const rel = path.relative(root, f).replace(/\\/g, '/')
    if (rel === 'src/billingStore.js') continue
    if (rel === 'src/lib/transactionOwnershipGuard.js') continue
    const src = fs.readFileSync(f, 'utf8')
    if (
      /\bgetLatestCompletedTransactionByNormalizedPhone\s*\(/.test(src) ||
      (/import\s*\{[^}]*getLatestCompletedTransactionByNormalizedPhone/.test(src) &&
        src.includes('getLatestCompletedTransactionByNormalizedPhone'))
    ) {
      offenders.push(rel)
    }
  }
  report.findings.phone_latest_txn_callers = offenders.length
  report.findings.phone_latest_txn_caller_files = offenders
  if (offenders.length) report.failures.push('phone_latest_txn_callers')

  const helper = fs.readFileSync(path.join(root, 'src/billingStore.js'), 'utf8')
  const start = helper.indexOf('export async function getLatestCompletedTransactionByNormalizedPhone')
  const end = helper.indexOf('export async function listActiveDeviceIdsForPaymentPhone', start)
  const fn = helper.slice(start, end > start ? end : start + 800)
  report.findings.phone_latest_helper_refuses =
    fn.includes('refuseTransactionHistoryOwnership') && !/ORDER BY t\.created_at DESC/.test(fn)
  if (!report.findings.phone_latest_helper_refuses) {
    report.failures.push('phone_latest_helper_not_refused')
  }

  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL required')

  // Every active entitlement is keyed by device_id (PK) — transaction history cannot be multi-owner SoT.
  const { rows: shared } = await pool.query(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT transaction_id
       FROM device_subscriptions
       WHERE status = 'active' AND expires_at > now()
         AND transaction_id IS NOT NULL AND trim(transaction_id::text) <> ''
       GROUP BY transaction_id
       HAVING COUNT(*) > 1
     ) x`,
  )
  report.findings.shared_active_transaction_id = Number(shared[0]?.n) || 0
  if (report.findings.shared_active_transaction_id > 0) {
    report.failures.push('shared_active_transaction_id')
  }

  const { rows: active } = await pool.query(
    `SELECT COUNT(*)::int AS n
     FROM device_subscriptions
     WHERE status = 'active' AND expires_at > now()`,
  )
  report.findings.active_entitlements = Number(active[0]?.n) || 0
  report.findings.note =
    'Ownership SoT is device_subscriptions.device_id. Transactions are audit/metadata only.'

  report.ok = report.failures.length === 0
  console.log(JSON.stringify(report, null, 2))
  await closePool().catch(() => {})
  if (!report.ok) process.exit(2)
}

main().catch(async (e) => {
  console.error('[audit-transaction-read-only-ownership] failed:', e)
  await closePool().catch(() => {})
  process.exit(1)
})
