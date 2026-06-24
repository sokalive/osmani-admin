import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const batch = JSON.parse(readFileSync(new URL('../../tmp-one-batch.json', import.meta.url)))
const sample = batch.migrated.slice(0, 20)
let ok = 0
let bad = 0
const failed = []
for (const row of sample) {
  const d = row.device_id
  for (const [label, base] of [
    ['VPS', 'https://api.osmanitv.com'],
    ['Render', 'https://osmani-admin-api.onrender.com'],
  ]) {
    try {
      const raw = execSync(
        `curl.exe --max-time 50 -s "${base}/api/subscription-status?device_id=${encodeURIComponent(d)}"`,
        { encoding: 'utf8' },
      )
      const b = JSON.parse(raw)
      const good = b.active === true && b.playbackAllowed === true
      if (good) ok++
      else {
        bad++
        failed.push({ host: label, device_id: d.slice(0, 20), status: b.status, active: b.active })
      }
    } catch (e) {
      bad++
      failed.push({ host: label, device_id: d.slice(0, 20), error: 'timeout' })
    }
  }
}
console.log(JSON.stringify({ sampled_devices: sample.length, checks: sample.length * 2, ok, bad, failed }, null, 2))
process.exit(bad > 0 ? 1 : 0)
