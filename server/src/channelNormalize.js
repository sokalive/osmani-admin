import path from 'node:path'

/** Migrate legacy stored rows to canonical shape */
export function migrateStoredChannel(c) {
  if (!c || typeof c !== 'object') return c
  const accessPremium = Boolean(c.accessPremium ?? c.access_premium)
  const accessType =
    c.accessType === 'premium' || c.accessType === 'free'
      ? c.accessType
      : accessPremium
        ? 'premium'
        : 'free'
  const thumbnail =
    c.thumbnail != null && String(c.thumbnail).trim() !== ''
      ? String(c.thumbnail).trim()
      : c.thumbnailUrl != null && String(c.thumbnailUrl).trim() !== ''
        ? String(c.thumbnailUrl).trim()
        : null

  return {
    ...c,
    isLive: c.isLive !== undefined ? Boolean(c.isLive) : Boolean(c.live),
    isHD: c.isHD !== undefined ? Boolean(c.isHD) : c.hd !== false,
    isActive: c.isActive !== undefined ? Boolean(c.isActive) : c.active !== false,
    showInApp:
      c.showInApp !== undefined
        ? Boolean(c.showInApp)
        : c.show_in_app !== undefined
          ? Boolean(c.show_in_app)
          : true,
    accessType,
    thumbnail,
    category: (c.category || 'General').trim() || 'General',
    url: (c.url || '').trim(),
    name: (c.name || '').trim(),
  }
}

function parseBool(v, defaultVal) {
  if (v === undefined || v === null || v === '') return defaultVal
  if (typeof v === 'boolean') return v
  const s = String(v).toLowerCase()
  if (s === 'true' || s === '1' || s === 'on' || s === 'yes') return true
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false
  return defaultVal
}

function str(v, d = '') {
  if (v == null) return d
  return String(v).trim()
}

/**
 * Build canonical channel fields from multipart or JSON body + optional uploaded file.
 * @param {Record<string, string>} body - req.body
 * @param {Express.Multer.File | undefined} file - multer file
 * @param {object | null} existing - previous row on PUT
 */
export function parseChannelInput(body, file, existing = null) {
  const b = body || {}
  const ex = existing ? migrateStoredChannel(existing) : null

  let thumbnail = null
  if (file) {
    thumbnail = `/uploads/${file.filename}`
  } else {
    const keep =
      str(b.existingThumbnail) ||
      str(b.existingThumbnailUrl) ||
      str(b.thumbnailUrl) ||
      (typeof b.thumbnail === 'string' && !b.thumbnail.startsWith('blob:') ? str(b.thumbnail) : '')
    if (keep) thumbnail = keep
    else if (ex?.thumbnail) thumbnail = ex.thumbnail
  }

  const accessRaw = str(b.accessType).toLowerCase()
  let accessType = 'free'
  if (accessRaw === 'premium' || accessRaw === 'free') {
    accessType = accessRaw
  } else if (parseBool(b.accessPremium, false)) {
    accessType = 'premium'
  } else if (ex?.accessType) {
    accessType = ex.accessType === 'premium' ? 'premium' : 'free'
  }

  return {
    name: str(b.name),
    url: str(b.url || b.streamUrlPrimary),
    category: str(b.category || b.displaySection, 'General') || 'General',
    thumbnail: thumbnail || null,
    isLive: parseBool(b.isLive ?? b.live, ex != null ? Boolean(ex.isLive) : true),
    isHD: parseBool(b.isHD ?? b.hd, ex != null ? Boolean(ex.isHD) : true),
    isActive: parseBool(b.isActive ?? b.active, ex != null ? Boolean(ex.isActive) : true),
    showInApp: parseBool(b.showInApp, ex != null ? Boolean(ex.showInApp) : true),
    accessType,
    backupStream1: str(b.backupStream1),
    backupStream2: str(b.backupStream2),
    origin: str(b.origin),
    referer: str(b.referer),
    userAgent: str(b.userAgent),
    playerType: str(b.playerType, 'Exo') || 'Exo',
  }
}

export function mergeChannelRecord(existing, parsed, id, nowIso) {
  const base = existing ? migrateStoredChannel(existing) : {}
  return {
    id,
    name: parsed.name,
    url: parsed.url,
    category: parsed.category,
    thumbnail: parsed.thumbnail ?? base.thumbnail ?? null,
    isLive: parsed.isLive,
    isHD: parsed.isHD,
    isActive: parsed.isActive,
    showInApp: parsed.showInApp,
    accessType: parsed.accessType,
    backupStream1: parsed.backupStream1,
    backupStream2: parsed.backupStream2,
    origin: parsed.origin,
    referer: parsed.referer,
    userAgent: parsed.userAgent,
    playerType: parsed.playerType,
    createdAt: base.createdAt || nowIso,
    updatedAt: nowIso,
  }
}

/** Public API shape (+ legacy aliases for older clients) */
export function channelToResponse(c, req) {
  const m = migrateStoredChannel({ ...c })
  const host = req ? `${req.protocol}://${req.get('host') || ''}` : ''
  const rel = m.thumbnail || null
  const thumbFull = rel && !rel.startsWith('http') ? `${host}${rel}` : rel

  return {
    id: m.id,
    name: m.name,
    url: m.url,
    thumbnail: rel,
    isLive: Boolean(m.isLive),
    isHD: Boolean(m.isHD),
    isActive: Boolean(m.isActive),
    showInApp: Boolean(m.showInApp),
    accessType: m.accessType === 'premium' ? 'premium' : 'free',
    category: m.category || 'General',
    backupStream1: m.backupStream1 ?? '',
    backupStream2: m.backupStream2 ?? '',
    origin: m.origin ?? '',
    referer: m.referer ?? '',
    userAgent: m.userAgent ?? '',
    playerType: m.playerType ?? 'Exo',
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    live: Boolean(m.isLive),
    hd: Boolean(m.isHD),
    active: Boolean(m.isActive),
    accessPremium: m.accessType === 'premium',
    thumbnailUrl: thumbFull,
  }
}

export function uploadsFilePathFromThumbnail(thumbnail) {
  if (!thumbnail || typeof thumbnail !== 'string') return null
  if (!thumbnail.startsWith('/uploads/')) return null
  return path.basename(thumbnail)
}
