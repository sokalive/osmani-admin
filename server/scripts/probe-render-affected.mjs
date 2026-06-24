import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const before = JSON.parse(readFileSync(new URL('../../tmp-before-audit.json', import.meta.url)))
const renderIds = []
for (const [id, host] of Object.entries(before.host_attribution || {})) {
  if (host === 'render') renderIds.push(id)
}
const results = []
let bad = 0
for (const d of renderIds) {
  const raw = execSync(
    `curl.exe --max-time 45 -s "https://api.osmanitv.com/api/subscription-status?device_id=${encodeURIComponent(d)}"`,
    { encoding: 'utf8' },
  )
  const b = JSON.parse(raw)
  const good = b.active === true && b.playbackAllowed === true
  if (!good) bad++
  results.push({ device_id: d, active: b.active, playback: b.playbackAllowed, status: b.status })
}
console.log(JSON.stringify({ render_users: renderIds.length, bad, results }, null, 2))
process.exit(bad > 0 ? 1 : 0)
