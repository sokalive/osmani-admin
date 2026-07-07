/**
 * T0–T8 channel accessType propagation harness.
 * Env: API_BASE, ADMIN_TOKEN, CHANNEL_ID, RAPID_TOGGLES (default 0), REVERT (default 1).
 */
const API_BASE = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const TOKEN =
  process.env.ADMIN_TOKEN ||
  process.env.ADMIN_LEGACY_TOKEN ||
  process.env.X_ADMIN_TOKEN ||
  '3030'
const REVERT = String(process.env.REVERT ?? '1').trim() !== '0'
const RAPID = Math.max(0, Number(process.env.RAPID_TOGGLES) || 0)

function ts() {
  return Date.now()
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString()
}

async function getChannels() {
  const t0 = ts()
  const res = await fetch(`${API_BASE}/api/channels`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  })
  const body = await res.json()
  return {
    t1: t0,
    t2: ts(),
    ms: ts() - t0,
    status: res.status,
    cacheHdr: res.headers.get('x-api-cache'),
    configVer: res.headers.get('x-config-version'),
    catalogRev: res.headers.get('x-catalog-revision'),
    body: Array.isArray(body) ? body : [],
  }
}

function pickChannel(list, idHint) {
  if (idHint) {
    const c = list.find((x) => String(x.id) === String(idHint))
    if (c) return c
  }
  return list.find((c) => c.name && c.url && !c.isInstructionVideo) || list[0]
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
  const tReq = ts()
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
  const tResp = ts()
  const json = await res.json().catch(() => null)
  return {
    tReq,
    tResp,
    ms: tResp - tReq,
    status: res.status,
    access: accessOf(json),
    configVer: res.headers.get('x-config-version'),
    body: json,
  }
}

async function probeSseChannelEvent(channelId, timeoutMs = 8000) {
  const url = `${API_BASE}/api/sync/stream?topics=config`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const tConnect = ts()
  let tEvent = null
  let eventData = null
  try {
    const res = await fetch(url, {
      headers: { Accept: 'text/event-stream' },
      cache: 'no-store',
      signal: controller.signal,
    })
    if (!res.ok) return { ok: false, detail: `SSE HTTP ${res.status}` }
    const reader = res.body?.getReader()
    if (!reader) return { ok: false, detail: 'no SSE body' }
    const decoder = new TextDecoder()
    let buffer = ''
    while (!tEvent && ts() - tConnect < timeoutMs) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const chunks = buffer.split('\n\n')
      buffer = chunks.pop() || ''
      for (const chunk of chunks) {
        const evMatch = chunk.match(/^event: (.+)$/m)
        const dataMatch = chunk.match(/^data: (.+)$/m)
        if (!evMatch || !dataMatch) continue
        const ev = evMatch[1].trim()
        if (!['channels_changed', 'channels_catalog', 'config.channels_changed'].includes(ev)) continue
        try {
          const data = JSON.parse(dataMatch[1])
          const cid = data?.channelId ?? data?.channel?.id
          if (cid != null && String(cid) === String(channelId)) {
            tEvent = ts()
            eventData = { ev, data }
            break
          }
        } catch {
          /* ignore */
        }
      }
    }
    await reader.cancel().catch(() => {})
    return {
      ok: tEvent != null,
      tConnect,
      tEvent,
      latencyMs: tEvent ? tEvent - tConnect : null,
      eventData,
    }
  } catch (e) {
    if (tEvent) {
      return { ok: true, tConnect, tEvent, latencyMs: tEvent - tConnect, eventData }
    }
    return { ok: false, detail: String(e.message || e), tConnect, tEvent }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}

async function runDirection(channel, direction, { sseBeforePut = false } = {}) {
  const before = accessOf(channel)
  const target = direction === 'premium' ? 'premium' : 'free'
  if (before === target) {
    return { skipped: true, reason: `already ${target}`, before, target }
  }

  const trace = { direction, before, target }
  trace.T0_adminToggleClick = ts()

  let sseProbe = null
  if (sseBeforePut) {
    sseProbe = probeSseChannelEvent(channel.id, 12000)
  }

  const put = await putAccess(channel, target)
  trace.T1_apiRequestReceived = put.tReq
  trace.T3_mutationResponseReturned = put.tResp
  trace.put = { status: put.status, ms: put.ms, access: put.access }

  const immediate = await getChannels()
  const row = immediate.body.find((c) => String(c.id) === String(channel.id))
  trace.T8_immediateGet = {
    t: immediate.t2,
    ms: immediate.ms,
    access: accessOf(row),
    matchesPut: accessOf(row) === target,
    xApiCache: immediate.cacheHdr,
    xConfigVersion: immediate.configVer,
    xCatalogRevision: immediate.catalogRev,
  }

  if (sseProbe) {
    const sse = await sseProbe
    trace.T6_realtimeEvent = sse.tEvent ? iso(sse.tEvent) : null
    trace.T7_sseDelivery = sse
  }

  let freshAt = trace.T8_immediateGet.matchesPut ? immediate.t2 : null
  if (!freshAt) {
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 200))
      const g = await getChannels()
      const r = g.body.find((c) => String(c.id) === String(channel.id))
      if (accessOf(r) === target) {
        freshAt = g.t2
        trace.freshGetAfterMs = g.t2 - put.tResp
        break
      }
    }
  }
  trace.propagationMs = freshAt ? freshAt - trace.T0_adminToggleClick : null

  return trace
}

async function main() {
  console.log('=== Channel access propagation harness (T0–T8) ===')
  console.log('API:', API_BASE)

  const warm = await getChannels()
  const channel = pickChannel(warm.body, process.env.CHANNEL_ID)
  if (!channel) {
    console.error('No channels found')
    process.exit(1)
  }

  console.log('\nTest channel:', { id: channel.id, name: channel.name, access: accessOf(channel) })

  const before = accessOf(channel)
  const firstTarget = before === 'premium' ? 'free' : 'premium'
  const secondTarget = before === 'premium' ? 'premium' : 'free'

  const traceFirst = await runDirection(channel, firstTarget)
  const merged = { ...channel, ...(traceFirst.put?.body || channel) }
  const traceSecond = await runDirection(merged, secondTarget)

  const rapidResults = []
  if (RAPID > 0) {
    let cur = { ...channel }
    let lastRev = Number(warm.configVer) || 0
    for (let i = 0; i < RAPID; i++) {
      const next = i % 2 === 0 ? 'premium' : 'free'
      const put = await putAccess(cur, next)
      const g = await getChannels()
      const rev = Number(g.configVer) || 0
      rapidResults.push({
        i,
        target: next,
        putAccess: put.access,
        getAccess: accessOf(g.body.find((c) => String(c.id) === String(channel.id))),
        rev,
        revMonotonic: rev >= lastRev,
      })
      lastRev = rev
      cur = { ...cur, ...(put.body || {}), accessType: next }
    }
  }

  const original = accessOf(channel)
  if (REVERT) {
    const cur = await getChannels()
    const row = cur.body.find((c) => String(c.id) === String(channel.id))
    if (row && accessOf(row) !== original) {
      await putAccess(row, original)
      console.log('\nReverted access to', original)
    }
  }

  const summary = {
    channelId: channel.id,
    channelName: channel.name,
    firstDirection: `${before}→${firstTarget}`,
    secondDirection: `${firstTarget}→${secondTarget}`,
    first: {
      propagationMs: traceFirst.propagationMs,
      immediateGetFresh: traceFirst.T8_immediateGet?.matchesPut,
      putReturnsFresh: traceFirst.put?.access === traceFirst.target,
    },
    second: {
      propagationMs: traceSecond.propagationMs,
      immediateGetFresh: traceSecond.T8_immediateGet?.matchesPut,
      putReturnsFresh: traceSecond.put?.access === traceSecond.target,
    },
    rapidToggles: RAPID > 0 ? rapidResults : undefined,
    rapidAllCorrect:
      RAPID > 0 ? rapidResults.every((r) => r.putAccess === r.target && r.getAccess === r.target) : undefined,
    rapidRevMonotonic: RAPID > 0 ? rapidResults.every((r) => r.revMonotonic) : undefined,
  }

  console.log(`\n--- Trace ${before}→${firstTarget} ---`)
  console.log(JSON.stringify(traceFirst, null, 2))
  console.log(`\n--- Trace ${firstTarget}→${secondTarget} ---`)
  console.log(JSON.stringify(traceSecond, null, 2))
  if (RAPID > 0) console.log('\n--- Rapid toggles ---', JSON.stringify(rapidResults, null, 2))
  console.log('\n=== Summary ===')
  console.log(JSON.stringify(summary, null, 2))

  const pass =
    traceFirst.put?.access === traceFirst.target &&
    traceSecond.put?.access === traceSecond.target &&
    traceFirst.T8_immediateGet?.matchesPut !== false &&
    traceSecond.T8_immediateGet?.matchesPut !== false &&
    (traceFirst.propagationMs == null || traceFirst.propagationMs <= 2000) &&
    (traceSecond.propagationMs == null || traceSecond.propagationMs <= 2000) &&
    (RAPID === 0 || (summary.rapidAllCorrect && summary.rapidRevMonotonic))

  process.exit(pass ? 0 : 1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
