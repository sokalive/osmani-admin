/**
 * Canonical channel id for live_sessions analytics (numeric id as string).
 * Maps legacy name/slug payloads and v15–v24 field variants to channels.id.
 */

function parseText(v) {
  const s = String(v ?? '').trim()
  return s || null
}

let _indexCache = null
let _indexCacheAt = 0
const INDEX_TTL_MS = Math.max(
  5000,
  Number(process.env.CHANNEL_ANALYTICS_INDEX_TTL_MS) || 60_000,
)

export function invalidateChannelAnalyticsIndex() {
  _indexCache = null
  _indexCacheAt = 0
}

/**
 * @returns {Promise<{ byId: Map<string, string>, byNameLower: Map<string, string> }>}
 */
export async function loadChannelAnalyticsIndex(pool) {
  const now = Date.now()
  if (_indexCache && now - _indexCacheAt < INDEX_TTL_MS) return _indexCache

  const byId = new Map()
  const byNameLower = new Map()
  if (!pool) {
    _indexCache = { byId, byNameLower }
    _indexCacheAt = now
    return _indexCache
  }

  const { rows } = await pool.query(
    `SELECT id::text AS id, name FROM channels ORDER BY sort_order ASC, id ASC`,
  )
  for (const row of rows) {
    const id = parseText(row.id)
    const name = parseText(row.name)
    if (!id) continue
    byId.set(id, id)
    if (/^\d+$/.test(id)) {
      byId.set(String(parseInt(id, 10)), id)
    }
    if (name) {
      byNameLower.set(name.toLowerCase(), id)
    }
  }

  _indexCache = { byId, byNameLower }
  _indexCacheAt = now
  return _indexCache
}

export function normalizeAnalyticsChannelId(raw, index) {
  const s = parseText(raw)
  if (!s || !index) return null

  if (/^\d+$/.test(s)) {
    const n = String(parseInt(s, 10))
    return index.byId.get(n) || n
  }

  const byName = index.byNameLower.get(s.toLowerCase())
  if (byName) return byName

  return s
}

/**
 * Resolve channel id from id and/or display name fields sent by APK v16–v24.
 */
export async function resolveAnalyticsChannelRef(pool, { channelId = null, channelName = null } = {}) {
  const index = await loadChannelAnalyticsIndex(pool)
  const fromId = normalizeAnalyticsChannelId(channelId, index)
  if (fromId && index.byId.has(fromId)) return fromId

  const fromName = normalizeAnalyticsChannelId(channelName, index)
  if (fromName && index.byId.has(fromName)) return fromName

  if (fromId && /^\d+$/.test(fromId)) return fromId
  if (fromName && /^\d+$/.test(fromName)) return fromName

  return fromId || fromName || null
}
