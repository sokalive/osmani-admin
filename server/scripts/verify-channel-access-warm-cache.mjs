/**
 * Warm-cache propagation test: populate GET cache, PUT, verify GET freshness.
 */
const API_BASE = String(process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_LEGACY_TOKEN || '3030'

async function getChannels(label) {
  const t0 = Date.now()
  const res = await fetch(`${API_BASE}/api/channels`, { cache: 'no-store' })
  const body = await res.json()
  const ms = Date.now() - t0
  return {
    label,
    ms,
    cacheHdr: res.headers.get('x-api-cache'),
    configVer: res.headers.get('x-config-version'),
    routingEpoch: res.headers.get('x-channels-routing-epoch'),
    body: Array.isArray(body) ? body : [],
  }
}

function accessOf(c) {
  return c?.accessType === 'premium' || c?.accessPremium ? 'premium' : 'free'
}

async function putAccess(channel, nextAccess) {
  const body = {
    name: channel.name,
    category: channel.category,
    bottomTab: channel.bottomTab ?? '',
    url: channel.url,
    backupStream1: channel.backupStream1 ?? '',
    backupStream2: channel.backupStream2 ?? '',
    origin: channel.origin ?? '',
    referer: channel.referer ?? '',
    userAgent: channel.userAgent ?? '',
    playerType: channel.playerType ?? 'exo',
    accessType: nextAccess,
    isLive: channel.isLive !== false,
    isHD: channel.isHD !== false,
    isActive: channel.isActive !== false,
    showInApp: channel.showInApp !== false,
    thumbnailUrl: channel.thumbnailUrl ?? null,
    sortOrder: Number(channel.sortOrder) || 0,
  }
  const res = await fetch(`${API_BASE}/api/channels/${channel.id}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  return { status: res.status, body: await res.json() }
}

async function main() {
  const warmRuns = []
  for (let i = 0; i < 5; i++) {
    warmRuns.push(await getChannels(`warm-${i + 1}`))
  }
  console.log(
    'Warm GET timings (ms):',
    warmRuns.map((r) => r.ms),
  )
  console.log('Headers on last warm:', {
    xApiCache: warmRuns.at(-1).cacheHdr,
    xConfigVersion: warmRuns.at(-1).configVer,
    xRoutingEpoch: warmRuns.at(-1).routingEpoch,
  })

  const channel = warmRuns.at(-1).body.find((c) => c.id === 1) || warmRuns.at(-1).body[0]
  const before = accessOf(channel)
  const target = before === 'premium' ? 'free' : 'premium'

  const put = await putAccess(channel, target)
  console.log('PUT', put.status, 'access', accessOf(put.body))

  const after = []
  for (let i = 0; i < 6; i++) {
    const g = await getChannels(`post-${i}`)
    const row = g.body.find((c) => String(c.id) === String(channel.id))
    after.push({
      i,
      ms: g.ms,
      access: accessOf(row),
      cacheHdr: g.cacheHdr,
      configVer: g.configVer,
    })
    if (accessOf(row) === target) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  console.log('Post-PUT GETs:', after)

  await putAccess({ ...channel, ...put.body }, before)
  console.log('Reverted to', before)
}

main().catch(console.error)
