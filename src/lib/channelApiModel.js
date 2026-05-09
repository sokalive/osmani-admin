const CATEGORY_GRADIENTS = {
  Sports: 'from-red-600 to-rose-700',
  News: 'from-blue-600 to-indigo-700',
  Movies: 'from-violet-600 to-purple-800',
  Kids: 'from-emerald-500 to-teal-700',
  Music: 'from-fuchsia-600 to-pink-700',
  Docs: 'from-amber-600 to-orange-800',
  General: 'from-indigo-600 to-purple-700',
}

const DISPLAY_SECTION_TO_LABEL = {
  general: 'General',
  sports: 'Sports',
  movies: 'Movies',
}

function normalizeDisplaySection(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return DISPLAY_SECTION_TO_LABEL[v] ? v : 'general'
}

function displaySectionLabel(value) {
  return DISPLAY_SECTION_TO_LABEL[normalizeDisplaySection(value)] || 'General'
}

const API_BASE_ENV = String(
  import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || '',
).trim()
const API_ORIGIN =
  (API_BASE_ENV ? API_BASE_ENV.replace(/\/$/, '').replace(/\/api$/, '') : '') ||
  'https://osmani-admin-api.onrender.com'

const PLAYER_UI_TO_API = {
  Exo: 'exo',
  WebView: 'webview',
  VLC: 'vlc',
  Native: 'native',
  IJK: 'ijk',
}

const PLAYER_API_TO_UI = {
  exo: 'Exo',
  webview: 'WebView',
  vlc: 'VLC',
  native: 'Native',
  ijk: 'IJK',
}

function resolveThumbnailUrl(c) {
  const rel = c?.thumbnail != null ? String(c.thumbnail).trim() : ''
  const abs = c?.thumbnailUrl != null ? String(c.thumbnailUrl).trim() : ''
  if (abs.startsWith('http')) return abs
  if (rel.startsWith('http')) return rel
  if (rel.startsWith('/')) return `${API_ORIGIN}${rel}`
  if (rel.length > 0 && !rel.startsWith('blob:')) return `${API_ORIGIN}/${rel.replace(/^\/+/, '')}`
  return null
}

/** API row → UI channel object for table + modal */
export function uiFromApiRow(c) {
  const displaySection = normalizeDisplaySection(c.displaySection ?? c.display_section)
  const category = c.category || displaySectionLabel(displaySection) || 'General'
  const accessPremium =
    c.accessType === 'premium' || Boolean(c.accessPremium === true || c.access_premium === true)
  const live = c.isLive !== undefined ? Boolean(c.isLive) : Boolean(c.live)
  const hd = c.isHD !== undefined ? Boolean(c.isHD) : c.hd !== false
  const active = c.isActive !== undefined ? Boolean(c.isActive) : c.active !== false
  const showInApp = c.showInApp !== undefined ? Boolean(c.showInApp) : c.show_in_app !== false

  const bottomTabsDisplay =
    c.bottomTab != null && String(c.bottomTab).trim() !== ''
      ? String(c.bottomTab).trim()
      : c.bottomTabsDisplay != null && String(c.bottomTabsDisplay).trim() !== ''
        ? String(c.bottomTabsDisplay).trim()
        : category
  const ptKey = String(c.playerType ?? 'exo').toLowerCase()
  const playerType = PLAYER_API_TO_UI[ptKey] ?? 'Exo'
  const thumbnail = resolveThumbnailUrl(c)

  return {
    id: String(c.id),
    name: c.name ?? '',
    category,
    displaySection,
    bottomTabsDisplay,
    /** Absolute URL for list/avatar; null if no image */
    thumbnail,
    logoLetter: (c.name?.[0] ?? '?').toUpperCase(),
    logoGradient: CATEGORY_GRADIENTS[category] || 'from-indigo-600 to-purple-700',
    accessPremium,
    live,
    hd,
    active,
    showInApp,
    streamUrlPrimary: c.url ?? '',
    backupStream1: c.backupStream1 ?? '',
    backupStream2: c.backupStream2 ?? '',
    origin: c.origin ?? '',
    referer: c.referer ?? '',
    userAgent: c.userAgent ?? '',
    playerType,
    thumbnailUrl: thumbnail,
  }
}

/** Build multipart FormData for POST/PUT /api/channels */
export function channelFormDataFromSubmit(submitPayload) {
  const s = submitPayload
  const fd = new FormData()
  const displaySection = normalizeDisplaySection(s.displaySection)
  const logicalPayload = {
    name: (s.name ?? '').trim(),
    url: (s.streamUrlPrimary ?? '').trim(),
    displaySection,
    display_section: displaySection,
    category: displaySectionLabel(displaySection),
    bottomTab:
      ((s.bottomTabsDisplay ?? displaySectionLabel(displaySection) ?? 'General').trim() || 'General'),
    isLive: Boolean(s.live),
    isHD: s.hd !== false,
    isActive: s.active !== false,
    showInApp: s.showInApp !== false,
    accessType: s.accessPremium ? 'premium' : 'free',
    backupStream1: (s.backupStream1 ?? '').trim(),
    backupStream2: (s.backupStream2 ?? '').trim(),
    origin: (s.origin ?? '').trim(),
    referer: (s.referer ?? '').trim(),
    userAgent: (s.userAgent ?? '').trim(),
    playerType: PLAYER_UI_TO_API[(s.playerType ?? 'Exo').trim() || 'Exo'] ?? 'exo',
    hasThumbnailBlob: Boolean(s.thumbnailFile instanceof Blob),
    existingThumbnailSent:
      typeof s.thumbnailPreviewUrl === 'string' &&
      !!s.thumbnailPreviewUrl &&
      !s.thumbnailPreviewUrl.startsWith('blob:'),
  }
  console.log('[channels multipart save] outgoing JSON:', JSON.stringify(logicalPayload))
  fd.append('name', (s.name ?? '').trim())
  fd.append('url', (s.streamUrlPrimary ?? '').trim())
  fd.append('displaySection', displaySection)
  fd.append('display_section', displaySection)
  fd.append('category', displaySectionLabel(displaySection))
  fd.append(
    'bottomTab',
    ((s.bottomTabsDisplay ?? displaySectionLabel(displaySection) ?? 'General').trim() || 'General'),
  )
  fd.append('isLive', String(Boolean(s.live)))
  fd.append('isHD', String(s.hd !== false))
  fd.append('isActive', String(s.active !== false))
  fd.append('showInApp', String(s.showInApp !== false))
  fd.append('accessType', s.accessPremium ? 'premium' : 'free')
  fd.append('backupStream1', (s.backupStream1 ?? '').trim())
  fd.append('backupStream2', (s.backupStream2 ?? '').trim())
  fd.append('origin', (s.origin ?? '').trim())
  fd.append('referer', (s.referer ?? '').trim())
  fd.append('userAgent', (s.userAgent ?? '').trim())
  const uiPt = (s.playerType ?? 'Exo').trim() || 'Exo'
  fd.append('playerType', PLAYER_UI_TO_API[uiPt] ?? 'exo')

  if (s.thumbnailFile instanceof Blob) {
    fd.append('thumbnail', s.thumbnailFile, s.thumbnailFile.name || 'thumbnail.jpg')
  } else if (
    typeof s.thumbnailPreviewUrl === 'string' &&
    s.thumbnailPreviewUrl &&
    !s.thumbnailPreviewUrl.startsWith('blob:')
  ) {
    fd.append('existingThumbnail', s.thumbnailPreviewUrl)
  }

  return fd
}

/** Modal submit payload → JSON body (quick toggles / non-file updates) */
export function apiBodyFromFormSubmit(s) {
  const displaySection = normalizeDisplaySection(s.displaySection)
  return {
    name: s.name?.trim() ?? '',
    displaySection,
    display_section: displaySection,
    category: displaySectionLabel(displaySection),
    bottomTab: (s.bottomTabsDisplay ?? displaySectionLabel(displaySection) ?? 'General').trim() || 'General',
    url: (s.streamUrlPrimary ?? '').trim(),
    backupStream1: (s.backupStream1 ?? '').trim(),
    backupStream2: (s.backupStream2 ?? '').trim(),
    origin: (s.origin ?? '').trim(),
    referer: (s.referer ?? '').trim(),
    userAgent: (s.userAgent ?? '').trim(),
    playerType: PLAYER_UI_TO_API[(s.playerType ?? 'Exo').trim() || 'Exo'] ?? 'exo',
    accessType: s.accessPremium ? 'premium' : 'free',
    isLive: Boolean(s.live),
    isHD: s.hd !== false,
    isActive: s.active !== false,
    showInApp: s.showInApp !== false,
    thumbnailUrl:
      typeof s.thumbnailPreviewUrl === 'string' && !s.thumbnailPreviewUrl.startsWith('blob:')
        ? s.thumbnailPreviewUrl
        : null,
  }
}

/** UI channel → API JSON body (e.g. toggle access) */
export function apiBodyFromUiChannel(ch) {
  const displaySection = normalizeDisplaySection(ch.displaySection)
  return {
    name: ch.name ?? '',
    displaySection,
    display_section: displaySection,
    category: ch.category ?? displaySectionLabel(displaySection) ?? 'General',
    bottomTab: ch.bottomTabsDisplay ?? displaySectionLabel(displaySection) ?? ch.category ?? 'General',
    url: ch.streamUrlPrimary ?? '',
    backupStream1: ch.backupStream1 ?? '',
    backupStream2: ch.backupStream2 ?? '',
    origin: ch.origin ?? '',
    referer: ch.referer ?? '',
    userAgent: ch.userAgent ?? '',
    playerType: PLAYER_UI_TO_API[(ch.playerType ?? 'Exo').toString().trim() || 'Exo'] ?? 'exo',
    accessType: ch.accessPremium ? 'premium' : 'free',
    isLive: Boolean(ch.live),
    isHD: ch.hd !== false,
    isActive: ch.active !== false,
    showInApp: ch.showInApp !== false,
    thumbnailUrl: ch.thumbnailUrl ?? null,
  }
}
