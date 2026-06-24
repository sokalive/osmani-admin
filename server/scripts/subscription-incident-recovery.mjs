/**
 * Subscription incident: audit + repair + post-verify.
 *
 *   cd server && node scripts/subscription-incident-recovery.mjs
 *   REPAIR=0 node scripts/subscription-incident-recovery.mjs   # audit only
 */
import '../src/loadEnv.js'
import { runSubscriptionIncidentAudit } from '../src/lib/subscriptionIncidentAudit.js'

const REPAIR = String(process.env.REPAIR ?? '1').trim() !== '0'

const report = await runSubscriptionIncidentAudit({ repair: REPAIR, reconcileBlocks: true })

console.log(JSON.stringify(report, null, 2))

console.log('\n=== SUMMARY ===')
console.log(`Before suspended: ${report.before.incorrectly_suspended_active}`)
console.log(`Before revoked shadows: ${report.before.incorrectly_revoked_migration_shadow}`)
console.log(`After suspended: ${report.after.incorrectly_suspended_active}`)
console.log(`After revoked shadows: ${report.after.incorrectly_revoked_migration_shadow}`)
console.log(`Recovered: ${report.recovered_users.length}`)
console.log(`Restoration unresolved: ${report.counts.restoration_unresolved}`)

if (
  report.after.incorrectly_suspended_active > 0 ||
  report.after.incorrectly_revoked_migration_shadow > 0 ||
  report.counts.restoration_unresolved > 0
) {
  process.exit(1)
}
