#!/usr/bin/env node
/**
 * Audit transfer source revocation + optional repair.
 * Usage: node server/scripts/audit-transfer-source-revocation.mjs [--repair]
 */
import '../src/loadEnv.js'
import { auditTransferSourceRevocation } from '../src/lib/transferRevocationGuard.js'

const repair = process.argv.includes('--repair')

async function main() {
  const report = await auditTransferSourceRevocation({ repair })
  console.log(JSON.stringify(report, null, 2))
  if (!repair && report.source_still_active_after_transfer > 0) {
    console.error(
      `\n${report.source_still_active_after_transfer} source device(s) still active — run with --repair to fix.`,
    )
    process.exitCode = 1
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
