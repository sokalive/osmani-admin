import {
  migrateContentCategory,
  parseVisibleTabsFromBottomTabField,
  serializeVisibleTabs,
  tabsFromCheckboxState,
} from '../../server/src/lib/channelTabs.js'

const CATEGORY_GRADIENTS = {
  Home: 'from-indigo-600 to-purple-700',
  Sports: 'from-red-600 to-rose-700',
  Tamthilia: 'from-violet-600 to-purple-800',
}

const API_BASE_ENV = String(
  import.meta.env.VITE_API_URL || import.meta.env.VITE_API_BASE_URL || '',
).trim()

function resolveApiOrigin() {
  if (API_BASE_ENV) {
    const clean = API_BASE_ENV.replace(/\/$/, '').replace(/\/api$/i, '')
    if (clean) return clean
  }
  if (typeof window !== 'undefined' && window.location?.origin) {
    return window.location.origin.replace(/\/$/, '')
  }
  return ''
}

const API_ORIGIN = resolveApiOrigin()

const PLAYER_UI_TO_API = {
  Exo: 'exo',
  WebView: 'webview',
  VLC: 'vlc',
  Native: 'native',
  IJK: 'ijk',
  'Direct HLS': 'direct_hls',
}

const PLAYER_API_TO_UI = {
  exo: 'Exo',
  webview: 'WebView',
  vlc: 'VLC',
  native: 'Native',
  ijk: 'IJK',
  direct_hls: 'Direct HLS',
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
  const category = migrateContentCategory(c.category)
  const accessPremium =
    c.accessType === 'premium' || Boolean(c.accessPremium === true || c.access_premium === true)
  const live = c.isLive !== undefined ? Boolean(c.isLive) : Boolean(c.live)
  const hd = c.isHD !== undefined ? Boolean(c.isHD) : c.hd !== false
  const active = c.isActive !== undefined ? Boolean(c.isActive) : c.active !== false
  const showInApp = c.showInApp !== undefined ? Boolean(c.showInApp) : c.show_in_app !== false

  const bottomRaw =
    c.bottomTab != null && String(c.bottomTab).trim() !== ''
      ? String(c.bottomTab).trim()
      : c.bottomTabsDisplay != null && String(c.bottomTabsDisplay).trim() !== ''
        ? String(c.bottomTabsDisplay).trim()
        : ''
  const visibleTabs = Array.isArray(c.visibleTabs)
    ? c.visibleTabs.map(String)
    : parseVisibleTabsFromBottomTabField(bottomRaw, category)
  const bottomTabsDisplay = serializeVisibleTabs(visibleTabs)
  const ptKey = String(c.playerType ?? 'exo').toLowerCase()
  const playerType = PLAYER_API_TO_UI[ptKey] ?? 'Exo'
  const thumbnail = resolveThumbnailUrl(c)

  return {
    id: String(c.id),
    sortOrder: Number(c.sortOrder ?? c.sort_order) || 0,
    name: c.name ?? '',
    category,
    displaySection: category,
    bottomTabsDisplay,
    visibleTabs,
    tabsLabel: visibleTabs.join(', '),
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
    isInstructionVideo: Boolean(
      c.instructionVideo || c.instruction_video || c.channelKind === 'instruction_video',
    ),
    isSystemLocked: Boolean(c.isSystemLocked ?? c.is_system_locked),
    instructionVisibility: String(c.instructionVisibility ?? c.instruction_visibility ?? 'all'),
    videoUrl: c.videoUrl ?? c.video_url ?? (c.url?.startsWith('/uploads/') ? c.url : ''),
  }
}

/** Build multipart FormData for POST/PUT /api/channels */
export function channelFormDataFromSubmit(submitPayload) {
  const s = submitPayload
  const line = migrateContentCategory(s.displaySection)
  const tabs = tabsFromCheckboxState(s.displaySection, s.tabHome, s.tabSports, s.tabTamthilia)
  const bottomTab = serializeVisibleTabs(tabs)
  const fd = new FormData()
  fd.append('name', (s.name ?? '').trim())
  if (!s.isInstructionVideo) {
    fd.append('url', (s.streamUrlPrimary ?? '').trim())
  }
  fd.append('category', line)
  fd.append('bottomTab', bottomTab)
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

  if (s.instructionVisibility) {
    fd.append('instructionVisibility', String(s.instructionVisibility))
  }

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
  const line = migrateContentCategory(s.displaySection)
  const tabs = tabsFromCheckboxState(s.displaySection, s.tabHome, s.tabSports, s.tabTamthilia)
  const bottomTab = serializeVisibleTabs(tabs)
  return {
    name: s.name?.trim() ?? '',
    category: line,
    bottomTab,
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
    isActive: Boolean(s.active),
    showInApp: Boolean(s.showInApp),
    thumbnailUrl:
      typeof s.thumbnailPreviewUrl === 'string' && !s.thumbnailPreviewUrl.startsWith('blob:')
        ? s.thumbnailPreviewUrl
        : null,
  }
}

/** UI channel → API JSON body (e.g. toggle access) */
export function apiBodyFromUiChannel(ch) {
  const line = migrateContentCategory(ch.category ?? ch.displaySection)
  const bottomStr = String(ch.bottomTabsDisplay ?? ch.bottomTab ?? '').trim()
  const hasExplicitTabs =
    ch.tabHome !== undefined || ch.tabSports !== undefined || ch.tabTamthilia !== undefined
  const tabs = hasExplicitTabs
    ? tabsFromCheckboxState(
        ch.displaySection ?? line,
        Boolean(ch.tabHome),
        Boolean(ch.tabSports),
        Boolean(ch.tabTamthilia),
      )
    : parseVisibleTabsFromBottomTabField(bottomStr, line)
  const bottomTab = serializeVisibleTabs(tabs)

  return {
    name: ch.name ?? '',
    category: line,
    bottomTab,
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
    isActive: Boolean(ch.active),
    showInApp: ch.showInApp !== false,
    thumbnailUrl: ch.thumbnailUrl ?? null,
    sortOrder: Number(ch.sortOrder) || 0,
  }
}
