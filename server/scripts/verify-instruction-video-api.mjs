#!/usr/bin/env node
/**
 * Verify VIDEO instruction channel API returns aligned VPS playback URLs.
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/$/, '')
const CHANNEL_ID = Number(process.env.INSTRUCTION_VIDEO_CHANNEL_ID || 19)

let pass = true
function ok(m) {
  console.log('PASS', m)
}
function fail(m) {
  pass = false
  console.error('FAIL', m)
}

async function main() {
  for (const vc of ['20', '24']) {
    const res = await fetch(`${VPS}/api/channels?version_code=${vc}`, { cache: 'no-store' })
    const list = await res.json()
    const ch = list.find((c) => Number(c.id) === CHANNEL_ID)
    if (!ch) {
      fail(`channel ${CHANNEL_ID} missing for version_code=${vc}`)
      continue
    }
    if (ch.channel_kind !== 'instruction_video' || !ch.instruction_video) {
      fail(`version_code=${vc}: not marked instruction_video`)
      continue
    }
    const canon = String(ch.video_url || ch.instruction_video_url || '').trim()
    if (!canon.startsWith('https://api.osmanitv.com/uploads/videos/')) {
      fail(`version_code=${vc}: video_url not VPS HTTPS: ${canon}`)
      continue
    }
    const aligned = [ch.playbackUrl, ch.stream_url, ch.direct_stream_url, ch.instruction_video_url]
    for (const field of aligned) {
      if (String(field || '').trim() !== canon) {
        fail(`version_code=${vc}: ${field} !== ${canon}`)
      }
    }
    const head = await fetch(canon, { method: 'HEAD' })
    if (!head.ok) fail(`version_code=${vc}: HEAD ${head.status} for ${canon}`)
    else ok(`version_code=${vc}: aligned URLs + HEAD ${head.status}`)
  }
  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
