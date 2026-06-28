/**
 * Production live presence audit — VPS + Render snapshot consistency.
 *
 * Usage:
 *   node scripts/verify-analytics-live-audit.mjs
 *   VPS_API=https://api.osmanitv.com RENDER_API=https://osmani-admin-api.onrender.com node scripts/verify-analytics-live-audit.mjs
 */
const VPS_API = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(
  /\/+$/,
  '',
)

let failed = 0

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function pass(msg) {
  console.log(`OK ${msg}`)
}

async function snapshot(base) {
  const res = await fetch(`${base}/api/analytics/snapshot`, { cache: 'no-store' })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, base }
}

function auditHost(label, snap) {
  const b = snap.body || {}
  const online = Number(b.onlineNow) || 0
  const watching = Number(b.watchingNow) || 0
  const idle = Number(b.idleNow) || 0
  const mwSum = (Array.isArray(b.mostWatched) ? b.mostWatched : []).reduce(
    (a, r) => a + (Number(r.viewers) || 0),
    0,
  )
  const locSum = (Array.isArray(b.locations) ? b.locations : []).reduce(
    (a, r) => a + (Number(r.users) || 0),
    0,
  )

  console.log(`\n=== ${label} (${snap.base}) ===`)
  console.log(
    JSON.stringify(
      {
        onlineNow: online,
        watchingNow: watching,
        idleNow: idle,
        mostWatchedChannels: b.mostWatched?.length ?? 0,
        mostWatchedSum: mwSum,
        locationsSum: locSum,
        top5Count: b.top5?.length ?? 0,
        top5MinViewers: b.top5MinViewers,
        livePresenceWindowSeconds: b.livePresenceWindowSeconds,
        sessionPruneSeconds: b.sessionPruneSeconds,
        degraded: b.degraded === true,
      },
      null,
      2,
    ),
  )

  if (snap.status !== 200) fail(`${label} snapshot HTTP ${snap.status}`)
  else pass(`${label} snapshot HTTP 200`)

  if (watching === mwSum) pass(`${label} watchingNow=${watching} matches channel sum`)
  else fail(`${label} watchingNow ${watching} != channel sum ${mwSum}`)

  if (online === watching + idle) pass(`${label} online=${online} = watching+idle`)
  else fail(`${label} online ${online} != watching ${watching} + idle ${idle}`)

  if (locSum === online || (locSum === 0 && online === 0)) {
    pass(`${label} locations sum ${locSum} matches online ${online}`)
  } else {
    fail(`${label} locations sum ${locSum} != online ${online}`)
  }
}

async function main() {
  const [vps, render] = await Promise.all([snapshot(VPS_API), snapshot(RENDER_API)])
  auditHost('VPS', vps)
  auditHost('RENDER', render)

  const v = vps.body || {}
  const r = render.body || {}
  if (Number(v.onlineNow) === Number(r.onlineNow)) {
    pass(`VPS/Render onlineNow match (${v.onlineNow})`)
  } else {
    fail(`VPS onlineNow ${v.onlineNow} != Render ${r.onlineNow} (shared DB drift unlikely)`)
  }

  if (failed > 0) {
    console.error(`\n${failed} audit check(s) failed`)
    process.exit(1)
  }
  console.log('\nLive presence audit passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
