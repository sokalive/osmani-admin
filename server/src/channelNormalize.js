import path from 'node:path'

const PLAYER_TYPES = new Set(['exo', 'webview', 'vlc', 'native', 'ijk'])
const DISPLAY_SECTIONS = new Set(['general', 'sports', 'movies'])
const DISPLAY_SECTION_LABEL = {
  general: 'General',
  sports: 'Sports',
  movies: 'Movies',
}

/** Coerce legacy/unknown values to general | sports | movies (never null). */
export function normalizeDisplaySection(v) {
  const s = String(v ?? '').trim().toLowerCase()
  const alias = {
    general: 'general',
    sports: 'sports',
    movies: 'movies',
  }
  const mapped = alias[s] ?? s
  return DISPLAY_SECTIONS.has(mapped) ? mapped : 'general'
}

function displaySectionToCategoryLabel(section) {
  const s = normalizeDisplaySection(section)
  return DISPLAY_SECTION_LABEL[s] || 'General'
}

/** Canonical playerType for API + storage */
export function normalizePlayerType(v) {
  const raw = String(v ?? 'exo')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '')
  const legacy = {
    exo: 'exo',
    exoplayer: 'exo',
    webview: 'webview',
    vlc: 'vlc',
    native: 'native',
    ijk: 'ijk',
    ijkplayer: 'ijk',
  }
  const mapped = legacy[raw] ?? raw
  return PLAYER_TYPES.has(mapped) ? mapped : 'exo'
}

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
  const category = (c.category || 'General').trim() || 'General'
  const displaySection = normalizeDisplaySection(c.displaySection ?? c.display_section)
  const bottomTabRaw =
    c.bottomTab != null && String(c.bottomTab).trim() !== ''
      ? String(c.bottomTab).trim()
      : c.bottomTabsDisplay != null && String(c.bottomTabsDisplay).trim() !== ''
        ? String(c.bottomTabsDisplay).trim()
        : c.bottom_tab != null && String(c.bottom_tab).trim() !== ''
          ? String(c.bottom_tab).trim()
          : category

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
    category,
    displaySection,
    bottomTab: bottomTabRaw || 'General',
    playerType: normalizePlayerType(c.playerType),
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

  const displaySection = normalizeDisplaySection(
    b.display_section ?? b.displaySection ?? b.category ?? b.display_section_label,
  )
  const categoryRaw = str(b.category, '')
  const category = categoryRaw || displaySectionToCategoryLabel(displaySection)
  const bottomTab =
    str(b.bottomTab || b.bottomTabsDisplay || b.bottom_tabs_display, '') ||
    (ex != null ? ex.bottomTab : '') ||
    category

  return {
    name: str(b.name),
    url: str(b.url || b.streamUrlPrimary),
    displaySection,
    category,
    bottomTab: bottomTab || category,
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
    playerType: normalizePlayerType(b.playerType ?? (ex != null ? ex.playerType : 'exo')),
  }
}

export function mergeChannelRecord(existing, parsed, id, nowIso) {
  const base = existing ? migrateStoredChannel(existing) : {}
  return {
    id,
    name: parsed.name,
    url: parsed.url,
    displaySection: parsed.displaySection,
    category: parsed.category,
    bottomTab: parsed.bottomTab,
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
    playerType: normalizePlayerType(parsed.playerType),
    createdAt: base.createdAt || nowIso,
    updatedAt: nowIso,
  }
}

const DEFAULT_PUBLIC_BASE = 'https://osmani-admin-api.onrender.com'

/**
 * Absolute thumbnail URL for API clients (DB stores `/uploads/...`).
 * Uses `process.env.BASE_URL` when set, else {@link DEFAULT_PUBLIC_BASE}.
 */
export function resolveThumbnailForApi(thumbnail, req) {
  if (thumbnail == null) return null
  const rel = String(thumbnail).trim()
  if (rel === '') return null
  if (rel.startsWith('http://') || rel.startsWith('https://')) return rel

  const baseUrl = (process.env.BASE_URL || DEFAULT_PUBLIC_BASE).replace(/\/$/, '')

  if (rel.startsWith('/uploads')) {
    return `${baseUrl}${rel}`
  }

  const host = req ? `${req.protocol}://${req.get('host') || ''}`.replace(/\/$/, '') : ''
  if (rel.startsWith('/') && host) {
    return `${host}${rel}`
  }
  if (rel.startsWith('/')) {
    return `${baseUrl}${rel}`
  }
  return `${baseUrl}/${rel.replace(/^\/+/, '')}`
}

/** Public API shape (+ legacy aliases for older clients) */
export function channelToResponse(c, req) {
  const m = migrateStoredChannel({ ...c })
  const rel = m.thumbnail || null
  const thumbFull = resolveThumbnailForApi(rel, req)
  const displaySection = normalizeDisplaySection(m.displaySection ?? m.display_section)

  const isActive = Boolean(m.isActive)
  const showInApp = Boolean(m.showInApp)

  return {
    id: m.id,
    name: m.name,
    url: m.url,
    thumbnail: thumbFull,
    isLive: Boolean(m.isLive),
    isHD: Boolean(m.isHD),
    isActive,
    showInApp,
    is_active: isActive,
    show_in_app: showInApp,
    accessType: m.accessType === 'premium' ? 'premium' : 'free',
    display_section: displaySection,
    displaySection,
    category: m.category || 'General',
    bottomTab: (m.bottomTab || m.category || 'General').trim() || 'General',
    backupStream1: m.backupStream1 ?? '',
    backupStream2: m.backupStream2 ?? '',
    origin: m.origin ?? '',
    referer: m.referer ?? '',
    userAgent: m.userAgent ?? '',
    playerType: normalizePlayerType(m.playerType),
    bottomTabsDisplay: m.bottomTab || m.category || 'General',
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
