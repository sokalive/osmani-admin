/**
 * Measure channel accessType propagation: PUT → immediate GET /api/channels.
 * Env: API_BASE, ADMIN_TOKEN (or ADMIN_LEGACY_TOKEN), CHANNEL_ID (optional).
 * Reverts accessType after test when REVERT=1 (default).
 */
const API_BASE = String(process.env.API_BASE || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const TOKEN =
  process.env.ADMIN_TOKEN ||
  process.env.ADMIN_LEGACY_TOKEN ||
  process.env.X_ADMIN_TOKEN ||
  '3030'
const REVERT = String(process.env.REVERT ?? '1').trim() !== '0'

async function getChannels() {
  const t0 = Date.now()
  const res = await fetch(`${API_BASE}/api/channels`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  const body = await res.json()
  return {
    ms: Date.now() - t0,
    status: res.status,
    cacheHdr: res.headers.get('x-api-cache'),
    configVer: res.headers.get('x-config-version'),
    body: Array.isArray(body) ? body : [],
  }
}

function pickChannel(list, idHint) {
  if (idHint) {
    const c = list.find((x) => String(x.id) === String(idHint))
    if (c) return c
  }
  return list.find((c) => c.name && c.url) || list[0]
}

function accessOf(c) {
  return c?.accessType === 'premium' || c?.accessPremium === true ? 'premium' : 'free'
}

async function putAccess(channel, nextAccess) {
  const body = {
    name: channel.name,
    category: channel.category,
    bottomTab: channel.bottomTab ?? channel.bottomTabsDisplay ?? '',
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
    thumbnailUrl: channel.thumbnailUrl ?? channel.thumbnail ?? null,
    sortOrder: Number(channel.sortOrder) || 0,
  }
  const t0 = Date.now()
  const res = await fetch(`${API_BASE}/api/channels/${channel.id}`, {
    method: 'PUT',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Admin-Token': TOKEN,
    },
    body: JSON.stringify(body),
    cache: 'no-store',
  })
  const json = await res.json().catch(() => null)
  return {
    ms: Date.now() - t0,
    status: res.status,
    access: accessOf(json),
    body: json,
  }
}

async function main() {
  console.log('=== Channel access propagation probe ===')
  console.log('API:', API_BASE)

  const warm = await getChannels()
  console.log('\nWarm GET:', {
    count: warm.body.length,
    ms: warm.ms,
    xApiCache: warm.cacheHdr,
    xConfigVersion: warm.configVer,
  })

  const channel = pickChannel(warm.body, process.env.CHANNEL_ID)
  if (!channel) {
    console.error('No channels found')
    process.exit(1)
  }

  const before = accessOf(channel)
  const target = before === 'premium' ? 'free' : 'premium'
  console.log('\nTest channel:', { id: channel.id, name: channel.name, before, target })

  const put = await putAccess(channel, target)
  console.log('\nPUT response:', { status: put.status, ms: put.ms, access: put.access })
  if (put.status !== 200) {
    console.error('PUT failed:', put.body)
    process.exit(1)
  }
  if (put.access !== target) {
    console.error('PUT body access mismatch — DB write or mapping issue')
    process.exit(1)
  }

  const immediate = await getChannels()
  const row = immediate.body.find((c) => String(c.id) === String(channel.id))
  const afterImmediate = accessOf(row)
  console.log('\nImmediate GET (0ms after PUT):', {
    ms: immediate.ms,
    xApiCache: immediate.cacheHdr,
    xConfigVersion: immediate.configVer,
    access: afterImmediate,
    matchesPut: afterImmediate === target,
  })

  const samples = []
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const g = await getChannels()
    const r = g.body.find((c) => String(c.id) === String(channel.id))
    const acc = accessOf(r)
    samples.push({
      tSec: (i + 1) * 2,
      access: acc,
      xApiCache: g.cacheHdr,
      configVer: g.configVer,
    })
    if (acc === target) break
  }

  console.log('\nPolling samples (2s interval):', samples)

  const staleUntilSec = samples.find((s) => s.access === target)?.tSec ?? null
  const stillStale = afterImmediate !== target

  if (REVERT && put.status === 200) {
    const rev = await putAccess({ ...channel, ...put.body }, before)
    console.log('\nReverted access to', before, 'status', rev.status)
  }

  console.log('\n=== Summary ===')
  console.log(
    JSON.stringify(
      {
        putReturnsFresh: put.access === target,
        getImmediateFresh: afterImmediate === target,
        staleOnImmediateGet: stillStale,
        propagationSec: staleUntilSec,
        likelyCacheDelay: stillStale || (staleUntilSec != null && staleUntilSec > 0),
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
