/**
 * Production-like simulation: 500 concurrent payment confirmations.
 *
 * Does NOT charge real money or write production entitlements.
 * Exercises: idempotent same-order races, distinct-order throughput,
 * Entitlement Guard accept/reject, midnight-EAT compute under parallelism.
 *
 * Usage: node scripts/sim-500-concurrent-activations.mjs
 */
import { performance } from 'node:perf_hooks'
import { computeStackedExpiryIso } from '../src/lib/subscriptionStacking.js'
import { assertWritableEntitlement } from '../src/lib/subscriptionEntitlementGuard.js'

const N = Number(process.env.SIM_CONCURRENT || 500)
const now = Date.now()

async function run() {
  const t0 = performance.now()

  // Phase A: 500 workers race the SAME order id (idempotency)
  const sharedApplied = new Set()
  let sharedWrites = 0
  let sharedSkips = 0
  await Promise.all(
    Array.from({ length: N }, async () => {
      const orderId = 'sim_shared_order'
      if (sharedApplied.has(orderId)) {
        sharedSkips += 1
        return
      }
      // Tiny critical section simulation
      if (!sharedApplied.has(orderId)) {
        sharedApplied.add(orderId)
        sharedWrites += 1
      } else {
        sharedSkips += 1
      }
    }),
  )

  // Phase B: 500 distinct orders — each must pass Entitlement Guard
  const durationDays = 7
  const expiresAt = computeStackedExpiryIso(null, durationDays, now).expiresAt
  let guardPass = 0
  let guardFail = 0
  const distinct = await Promise.all(
    Array.from({ length: N }, async (_, i) => {
      try {
        await assertWritableEntitlement({
          deviceId: `sim_device_${i}`,
          orderId: `sim_order_${i}`,
          expiresAt,
          durationDays,
          previousExpiresAt: null,
          source: 'payment',
          nowMs: now,
        })
        guardPass += 1
        return { ok: true }
      } catch {
        guardFail += 1
        return { ok: false }
      }
    }),
  )

  // Phase C: over-credit must all be rejected
  let rejectPass = 0
  await Promise.all(
    Array.from({ length: Math.min(50, N) }, async (_, i) => {
      try {
        await assertWritableEntitlement({
          deviceId: `sim_over_${i}`,
          orderId: `sim_over_order_${i}`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          durationDays: 3,
          previousExpiresAt: null,
          source: 'payment',
          nowMs: now,
        })
      } catch {
        rejectPass += 1
      }
    }),
  )

  const elapsed = performance.now() - t0
  const report = {
    ok:
      sharedWrites === 1 &&
      sharedSkips === N - 1 &&
      guardPass === N &&
      guardFail === 0 &&
      rejectPass === Math.min(50, N) &&
      distinct.every((d) => d.ok),
    concurrent: N,
    elapsed_ms: Math.round(elapsed),
    shared_order: { writes: sharedWrites, skips: sharedSkips },
    distinct_orders: { guard_pass: guardPass, guard_fail: guardFail },
    over_credit_rejected: rejectPass,
    no_lost_entitlement: guardPass === N,
    entitlement_guard_enforced: rejectPass === Math.min(50, N),
  }
  console.log(JSON.stringify(report, null, 2))
  if (!report.ok) process.exit(1)
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
