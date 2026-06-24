/**
 * Run batch shadow repair on production until remaining shadows = 0.
 *   node server/scripts/run-shadow-repair-batches.mjs
 */
const API = String(process.env.API_BASE || process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || '3030'
const MAX_ROUNDS = Math.max(1, Number(process.env.MAX_ROUNDS) || 20)

async function batch() {
  const res = await fetch(`${API}/api/runtime/subscription-shadow-repair-batch?shadow_limit=10&orphan_limit=5`, {
    method: 'POST',
    headers: { 'X-Admin-Token': TOKEN, 'Content-Type': 'application/json' },
    cache: 'no-store',
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`)
  return body
}

const allMigrated = []
const allFailed = []
let before = null

for (let round = 1; round <= MAX_ROUNDS; round++) {
  const r = await batch()
  if (!before) before = r.before
  allMigrated.push(...(r.migrated || []))
  allFailed.push(...(r.failed || []))
  console.log(
    `round ${round}: migrated=${r.migrated?.length || 0} failed=${r.failed?.length || 0} remaining=${r.remaining_unique_shadows} after.shadows=${r.after?.shadows}`,
  )
  if ((r.after?.shadows ?? 0) === 0 && (r.after?.orphans ?? 0) === 0 && (r.failed?.length ?? 0) === 0) {
    console.log('\nDONE')
    console.log(
      JSON.stringify(
        {
          ok: true,
          rounds: round,
          before,
          after: r.after,
          total_migrated: allMigrated.length,
          total_failed: allFailed.length,
          migrated: allMigrated,
          failed: allFailed,
          commit: r.commit,
        },
        null,
        2,
      ),
    )
    process.exit(0)
  }
  if ((r.batch_size ?? 0) === 0 && (r.orphans_finalized?.length ?? 0) === 0) break
}

console.error('INCOMPLETE after max rounds')
console.log(JSON.stringify({ before, total_migrated: allMigrated.length, failed: allFailed }, null, 2))
process.exit(1)
