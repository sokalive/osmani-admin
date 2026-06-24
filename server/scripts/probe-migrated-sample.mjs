/**
 * Probe migrated targets from tmp-one-batch.json via curl (Windows-friendly).
 */
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const batch = JSON.parse(readFileSync(new URL('../../tmp-one-batch.json', import.meta.url)))
const ids = batch.migrated.map((m) => m.device_id)
const sample = ids
let ok = 0
let bad = 0
const failed = []
for (const d of sample) {
  try {
    const raw = execSync(
      `curl.exe --max-time 45 -s "https://api.osmanitv.com/api/subscription-status?device_id=${encodeURIComponent(d)}"`,
      { encoding: 'utf8' },
    )
    const b = JSON.parse(raw)
    const good = b.active === true && b.blocked !== true && b.playbackAllowed === true
    if (good) ok++
    else {
      bad++
      failed.push({ device_id: d, status: b.status, active: b.active, playback: b.playbackAllowed })
    }
  } catch (e) {
    bad++
    failed.push({ device_id: d, error: String(e.message || e) })
  }
}
console.log(JSON.stringify({ sampled: sample.length, ok, bad, failed: failed.slice(0, 10) }, null, 2))
process.exit(bad > 0 ? 1 : 0)
