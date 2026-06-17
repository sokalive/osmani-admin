/**
 * Verify whether GET /api/runtime/app-modes reflects configVersion bumps from channel writes.
 */
const API_BASE = String(process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN = process.env.ADMIN_TOKEN || '3030'

async function getAppModes() {
  const t0 = Date.now()
  const res = await fetch(`${API_BASE}/api/runtime/app-modes`, { cache: 'no-store' })
  const body = await res.json()
  return {
    ms: Date.now() - t0,
    v: body?.v,
    cacheHdr: res.headers.get('x-api-cache'),
    body,
  }
}

async function getChannelsConfigVer() {
  const res = await fetch(`${API_BASE}/api/channels`, { cache: 'no-store' })
  return {
    v: res.headers.get('x-config-version'),
    cacheHdr: res.headers.get('x-api-cache'),
  }
}

async function toggleChannelAccess() {
  const listRes = await fetch(`${API_BASE}/api/channels`, { cache: 'no-store' })
  const list = await listRes.json()
  const ch = list.find((c) => c.id === 1) || list[0]
  const before = ch.accessType === 'premium' ? 'premium' : 'free'
  const target = before === 'premium' ? 'free' : 'premium'
  const body = {
    name: ch.name,
    category: ch.category,
    bottomTab: ch.bottomTab ?? '',
    url: ch.url,
    backupStream1: ch.backupStream1 ?? '',
    backupStream2: ch.backupStream2 ?? '',
    origin: ch.origin ?? '',
    referer: ch.referer ?? '',
    userAgent: ch.userAgent ?? '',
    playerType: ch.playerType ?? 'exo',
    accessType: target,
    isLive: ch.isLive !== false,
    isHD: ch.isHD !== false,
    isActive: ch.isActive !== false,
    showInApp: ch.showInApp !== false,
    thumbnailUrl: ch.thumbnailUrl ?? null,
    sortOrder: Number(ch.sortOrder) || 0,
  }
  const putRes = await fetch(`${API_BASE}/api/channels/${ch.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const putBody = await putRes.json()
  return { ch, before, target, putStatus: putRes.status, putBody }
}

async function main() {
  const warm = []
  for (let i = 0; i < 4; i++) warm.push(await getAppModes())
  const vBefore = warm.at(-1).v
  console.log('App-modes warm v:', warm.map((w) => w.v), 'cache:', warm.map((w) => w.cacheHdr))

  const channelsBefore = await getChannelsConfigVer()
  console.log('Channels X-Config-Version before PUT:', channelsBefore.v)

  const toggle = await toggleChannelAccess()
  console.log('Toggled channel', toggle.ch?.name, toggle.before, '->', toggle.target)

  const modesImmediate = await getAppModes()
  const channelsImmediate = await getChannelsConfigVer()
  console.log('\nImmediate after PUT:')
  console.log('  app-modes v:', modesImmediate.v, 'cache:', modesImmediate.cacheHdr, 'delta:', modesImmediate.v - vBefore)
  console.log('  channels header v:', channelsImmediate.v)

  const samples = []
  for (let i = 0; i < 20; i++) {
    const m = await getAppModes()
    const c = await getChannelsConfigVer()
    samples.push({ t: i, appModesV: m.v, channelsV: c.v, cache: m.cacheHdr })
    if (Number(m.v) > Number(vBefore)) break
    await new Promise((r) => setTimeout(r, 500))
  }
  console.log('\nPoll until app-modes v bumps:', samples)

  // revert
  const revTarget = toggle.before
  const b = {
    ...toggle.putBody,
    accessType: revTarget,
  }
  await fetch(`${API_BASE}/api/channels/${toggle.ch.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': TOKEN },
    body: JSON.stringify({
      name: b.name,
      category: b.category,
      bottomTab: b.bottomTab ?? '',
      url: b.url,
      backupStream1: b.backupStream1 ?? '',
      backupStream2: b.backupStream2 ?? '',
      origin: b.origin ?? '',
      referer: b.referer ?? '',
      userAgent: b.userAgent ?? '',
      playerType: b.playerType ?? 'exo',
      accessType: revTarget,
      isLive: b.isLive !== false,
      isHD: b.isHD !== false,
      isActive: b.isActive !== false,
      showInApp: b.showInApp !== false,
      thumbnailUrl: b.thumbnailUrl ?? null,
      sortOrder: Number(b.sortOrder) || 0,
    }),
    cache: 'no-store',
  })
}

main().catch(console.error)
