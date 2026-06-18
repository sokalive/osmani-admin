/**
 * Run safe subscription restoration repair (VPS/Render shell).
 *   cd server && node scripts/run-subscription-repair.mjs
 */
import '../src/loadEnv.js'
import { runSubscriptionRestorationAudit } from '../src/lib/subscriptionRestorationAudit.js'

const report = await runSubscriptionRestorationAudit({ repair: true })
console.log(JSON.stringify(report, null, 2))
if (report.unresolved_users_count > 0) process.exit(1)
