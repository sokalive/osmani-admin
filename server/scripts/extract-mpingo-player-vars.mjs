/**
 * Extract Mpingo player.php embedded stream/auth variables per upstream channel.
 */
const UA =
  'Mozilla/5.0 (Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36'

const API = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')

function parseVars(body) {
  const pick = (name) => {
    const m = body.match(new RegExp(`var ${name}\\s*=\\s*"([^"]*)"`, 'i'))
    return m ? m[1] : null
  }
  const pickBare = (name) => {
    const m = body.match(new RegExp(`var ${name}\\s*=\\s*([^;\\n]+)`, 'i'))
    return m ? m[1].trim().replace(/^"|"$/g, '') : null
  }
  return {
    streamUrl: pick('streamUrl'),
    streamType: pick('streamType'),
    clearKey: pick('clearKey'),
    detectedIdentity: pick('detectedIdentity'),
    mpingoApiKey: pick('mpingoApiKey') ? '[present]' : null,
    title: (body.match(/<title[^>]*>([^<]+)/i) || [])[1]?.trim() || null,
    hasStreamUrl: Boolean(pick('streamUrl')),
    clearKeyPresent: Boolean(pick('clearKey')),
  }
}

const channelsRes = await fetch(`${API}/api/channels`)
const payload = await channelsRes.json()
const all = payload.channels || payload
const mpingo = all.filter((c) => /mpingotv\.com/i.test(c.url || ''))

const byUpstream = new Map()
for (const ch of mpingo) {
  const id = new URL(ch.url).searchParams.get('channel')
  if (!byUpstream.has(id)) {
    const r = await fetch(`https://nur.mpingotv.com/v3/player.php?channel=${id}`, {
      headers: { 'User-Agent': UA, Referer: 'https://nur.mpingotv.com' },
    })
    const body = await r.text()
    byUpstream.set(id, { upstream_id: id, status: r.status, ...parseVars(body), catalog: [] })
  }
  byUpstream.get(id).catalog.push({ id: ch.id, name: ch.name })
}

const rows = [...byUpstream.values()].sort((a, b) => Number(a.upstream_id) - Number(b.upstream_id))
const authorizedPackages = rows.map((r) => r.detectedIdentity).filter(Boolean)
const uniqueAuth = [...new Set(authorizedPackages)]

console.log(
  JSON.stringify(
    {
      audited_at: new Date().toISOString(),
      unique_authorized_package_lists: uniqueAuth,
      all_channels_share_same_auth_list: uniqueAuth.length <= 1,
      channels_missing_clear_key: rows.filter((r) => !r.clearKeyPresent).map((r) => r.upstream_id),
      channels_with_clear_key: rows.filter((r) => r.clearKeyPresent).map((r) => r.upstream_id),
      rows: rows.map((r) => ({
        upstream_id: r.upstream_id,
        title: r.title,
        streamType: r.streamType,
        hasStreamUrl: r.hasStreamUrl,
        clearKeyPresent: r.clearKeyPresent,
        clearKeyLen: r.clearKey ? r.clearKey.length : 0,
        authorized_packages: r.detectedIdentity,
        catalog: r.catalog,
        streamUrlHost: r.streamUrl ? new URL(r.streamUrl).host : null,
      })),
    },
    null,
    2
  )
)
