#!/usr/bin/env node
/**
 * Classify stale SonicPesa pending orders via provider lookup (DRY RUN by default).
 * Usage:
 *   node scripts/reconcile-stale-sonicpesa-pending.mjs
 *   node scripts/reconcile-stale-sonicpesa-pending.mjs --apply --limit=20
 */
import 'dotenv/config'
import { getPool } from '../src/db/pool.js'
import { ensureBillingStorage } from '../src/billingStore.js'
import { resolveSonicpesaCredentials, sonicpesaGetOrderStatus } from '../src/sonicpesaClient.js'
import { applySonicpesaPaymentOutcome, COMPLETION_SOURCE } from '../src/lib/canonicalPaymentActivation.js'

const args = process.argv.slice(2)
const dryRun = !args.includes('--apply')
const limit = Math.min(500, Math.max(1, Number(args.find((a) => a.startsWith('--limit='))?.split('=')[1] ?? 50)))
const staleMinutes = Math.max(30, Number(args.find((a) => a.startsWith('--stale-min='))?.split('=')[1] ?? 30))
const concurrency = Math.min(5, Math.max(1, Number(process.env.SONICPESA_RECONCILE_CONCURRENCY ?? 3)))

function redactOrderId(id) {
  const s = String(id ?? '')
  return s.length <= 14 ? s : `${s.slice(0, 10)}…${s.slice(-2)}`
}

function classifyProvider(normalized, httpOk) {
  if (!httpOk) return 'PROVIDER_LOOKUP_ERROR'
  if (!normalized) return 'PROVIDER_EVIDENCE_UNAVAILABLE'
  if (normalized.succeeded) return 'PROVIDER_CONFIRMED_SUCCESS'
  if (normalized.failed) return 'PROVIDER_CONFIRMED_FAILED'
  if (String(normalized.paymentStatus ?? '').toUpperCase() === 'PENDING') return 'PROVIDER_CONFIRMED_PENDING'
  if (!normalized.providerOrderId && !normalized.paymentStatus) return 'PROVIDER_NOT_FOUND'
  return 'PROVIDER_CONFIRMED_PENDING'
}

async function mapPool(items, fn, n) {
  const out = []
  let i = 0
  async function worker() {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, () => worker()))
  return out
}

async function main() {
  await ensureBillingStorage()
  const pool = getPool()
  if (!pool) throw new Error('DATABASE_URL required')

  const { rows } = await pool.query(
    `SELECT order_id, external_id, device_id, raw_payload, created_at
     FROM transactions
     WHERE status = 'pending'
       AND created_at < now() - ($1::int || ' minutes')::interval
       AND COALESCE(raw_payload->>'payment_provider', '') = 'sonicpesa'
       AND COALESCE(order_id, '') ~ '^osm(_sp)?_'
     ORDER BY created_at ASC
     LIMIT $2`,
    [staleMinutes, limit],
  )

  const srow = await pool.query(`SELECT * FROM sonicpesa_settings WHERE id = 1`)
  const cred = resolveSonicpesaCredentials(srow.rows[0] || {})

  const summary = {
    dry_run: dryRun,
    scanned: rows.length,
    provider_confirmed_success: 0,
    provider_confirmed_failed: 0,
    provider_confirmed_pending: 0,
    provider_not_found: 0,
    provider_lookup_error: 0,
    provider_evidence_unavailable: 0,
    abandoned_or_unproven: 0,
    reconciled_success: 0,
    intentionally_not_granted: 0,
    samples: [],
  }

  const results = await mapPool(
    rows,
    async (row) => {
      const verifyId = String(row.raw_payload?.provider_order_id ?? row.external_id ?? row.order_id).trim()
      let httpOk = false
      let normalized = null
      try {
        const z = await sonicpesaGetOrderStatus(cred, verifyId)
        httpOk = z.ok === true
        normalized = z.normalized ?? null
      } catch {
        httpOk = false
      }
      const classification = classifyProvider(normalized, httpOk)
      const sample = {
        order_id_redacted: redactOrderId(row.order_id),
        classification,
        verify_id_redacted: redactOrderId(verifyId),
      }
      summary.samples.push(sample)

      switch (classification) {
        case 'PROVIDER_CONFIRMED_SUCCESS':
          summary.provider_confirmed_success += 1
          if (!dryRun) {
            const out = await applySonicpesaPaymentOutcome({
              orderId: row.order_id,
              source: COMPLETION_SOURCE.ADMIN_RECOVERY,
              succeeded: true,
              failed: false,
              providerPayload: normalized?.raw ?? null,
              externalId: normalized?.transId ?? row.external_id,
            })
            if (out.txnStatusAfter === 'completed') summary.reconciled_success += 1
          }
          break
        case 'PROVIDER_CONFIRMED_FAILED':
          summary.provider_confirmed_failed += 1
          if (!dryRun) {
            await applySonicpesaPaymentOutcome({
              orderId: row.order_id,
              source: COMPLETION_SOURCE.ADMIN_RECOVERY,
              succeeded: false,
              failed: true,
              providerPayload: normalized?.raw ?? null,
            })
          }
          break
        case 'PROVIDER_CONFIRMED_PENDING':
          summary.provider_confirmed_pending += 1
          summary.intentionally_not_granted += 1
          break
        case 'PROVIDER_NOT_FOUND':
          summary.provider_not_found += 1
          summary.abandoned_or_unproven += 1
          summary.intentionally_not_granted += 1
          break
        case 'PROVIDER_LOOKUP_ERROR':
          summary.provider_lookup_error += 1
          break
        case 'PROVIDER_EVIDENCE_UNAVAILABLE':
          summary.provider_evidence_unavailable += 1
          summary.intentionally_not_granted += 1
          break
        default:
          summary.abandoned_or_unproven += 1
          summary.intentionally_not_granted += 1
      }
      return sample
    },
    concurrency,
  )

  console.log(JSON.stringify({ ok: true, summary, result_count: results.length }, null, 2))
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: String(e.message || e) }))
  process.exit(1)
})
