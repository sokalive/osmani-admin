import path from 'node:path'
import {
  migrateContentCategory,
  parseVisibleTabsFromBottomTabField,
  serializeVisibleTabs,
} from './lib/channelTabs.js'
import { resolvePublicAssetUrl } from './lib/cdnAssets.js'
import { buildChannelStreamDelivery } from './lib/streamDelivery.js'
import {
  getCachedMpingoPlayerMetadata,
  mpingoNeedsChromePlayer,
} from './lib/mpingoPlayerMetadata.js'
import { isMpingoPlayerPageUrl } from './lib/streamMpingoHtmlBase.js'
import {
  instructionChannelApiExtras,
  instructionChannelVisibleForClient,
  instructionVideoRelativePathFromStored,
  isInstructionVideoChannelName,
  normalizeInstructionVisibility,
  resolveInstructionVideoPlaybackForApi,
} from './lib/instructionVideoChannel.js'

const PLAYER_TYPES = new Set(['exo', 'webview', 'vlc', 'native', 'ijk', 'chrome', 'direct_hls'])

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
    chrome: 'chrome',
    googlechrome: 'chrome',
    directhls: 'direct_hls',
    direct_hls: 'direct_hls',
    'direct-hls': 'direct_hls',
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
  const categoryRaw = (c.category || 'General').trim() || 'General'
  const category = migrateContentCategory(categoryRaw)
  const bottomTabRaw =
    c.bottomTab != null && String(c.bottomTab).trim() !== ''
      ? String(c.bottomTab).trim()
      : c.bottomTabsDisplay != null && String(c.bottomTabsDisplay).trim() !== ''
        ? String(c.bottomTabsDisplay).trim()
        : c.bottom_tab != null && String(c.bottom_tab).trim() !== ''
          ? String(c.bottom_tab).trim()
          : categoryRaw
  const visibleTabs = parseVisibleTabsFromBottomTabField(bottomTabRaw, category)
  const bottomTab = serializeVisibleTabs(visibleTabs)

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
    bottomTab,
    playerType: normalizePlayerType(c.playerType),
    sortOrder: Number(c.sortOrder ?? c.sort_order) || 0,
    url: (c.url || '').trim(),
    name: (c.name || '').trim(),
    channelKind: String(c.channelKind ?? c.channel_kind ?? 'standard'),
    instructionVisibility: normalizeInstructionVisibility(
      c.instructionVisibility ?? c.instruction_visibility,
    ),
    isSystemLocked: Boolean(c.isSystemLocked ?? c.is_system_locked),
    instructionVideoUrl: String(c.instructionVideoUrl ?? c.instruction_video_url ?? '').trim(),
    instructionVideoStatus: String(c.instructionVideoStatus ?? c.instruction_video_status ?? '').trim(),
  }
}

export function isInstructionVideoChannelRow(c) {
  if (!c || typeof c !== 'object') return false
  const kind = String(c.channelKind ?? c.channel_kind ?? '').trim().toLowerCase()
  if (kind === 'instruction_video') return true
  return isInstructionVideoChannelName(c.name)
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

function normalizeStoredUploadPath(value) {
  const raw = str(value)
  if (!raw) return ''
  if (raw.startsWith('/uploads/')) return raw
  try {
    const parsed = new URL(raw)
    if (parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname
    }
  } catch {
    // Keep non-URL values unchanged.
  }
  return raw
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
  const instruction = isInstructionVideoChannelRow(ex)

  let thumbnail = null
  if (file) {
    thumbnail = `/uploads/${file.filename}`
  } else {
    const keep =
      str(b.existingThumbnail) ||
      str(b.existingThumbnailUrl) ||
      str(b.thumbnailUrl) ||
      (typeof b.thumbnail === 'string' && !b.thumbnail.startsWith('blob:') ? str(b.thumbnail) : '')
    if (keep) thumbnail = normalizeStoredUploadPath(keep)
    else if (ex?.thumbnail) thumbnail = ex.thumbnail
  }

  const accessRaw = str(b.accessType).toLowerCase()
  let accessType = 'free'
  if (instruction) {
    accessType = 'free'
  } else if (accessRaw === 'premium' || accessRaw === 'free') {
    accessType = accessRaw
  } else if (parseBool(b.accessPremium, false)) {
    accessType = 'premium'
  } else if (ex?.accessType) {
    accessType = ex.accessType === 'premium' ? 'premium' : 'free'
  }

  const category = migrateContentCategory(str(b.category || b.displaySection, '') || 'Home')
  const bottomTabField =
    str(b.bottomTab || b.bottomTabsDisplay || b.bottom_tabs_display, '') ||
    (ex != null ? str(ex.bottomTab, '') : '')
  const tabs = parseVisibleTabsFromBottomTabField(bottomTabField || category, category)
  const bottomTab = serializeVisibleTabs(tabs)

  const instructionVisibility = instruction
    ? normalizeInstructionVisibility(b.instructionVisibility ?? b.instruction_visibility ?? ex?.instructionVisibility)
    : normalizeInstructionVisibility(ex?.instructionVisibility)

  const streamUrl = str(b.url || b.streamUrlPrimary)
  const resolvedUrl = instruction
    ? instructionVideoRelativePathFromStored(ex) || String(ex?.url ?? '').trim()
    : streamUrl

  return {
    name: instruction ? (ex?.name || 'VIDEO') : str(b.name),
    url: resolvedUrl,
    category,
    bottomTab,
    thumbnail: thumbnail || null,
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
    sortOrder:
      b.sortOrder != null || b.sort_order != null
        ? Number(b.sortOrder ?? b.sort_order) || 0
        : ex != null
          ? Number(ex.sortOrder) || 0
          : 0,
    channelKind: instruction ? 'instruction_video' : String(ex?.channelKind ?? 'standard'),
    instructionVisibility,
    isSystemLocked: instruction ? true : Boolean(ex?.isSystemLocked),
    isLive: instruction ? false : parseBool(b.isLive ?? b.live, ex != null ? Boolean(ex.isLive) : true),
  }
}

/** Display name for a duplicated channel (avoids repeated " (Copy)" suffixes). */
export function duplicateChannelDisplayName(name) {
  const base = String(name ?? '').trim() || 'Channel'
  if (/\s*\(copy\)\s*$/i.test(base)) return base
  return `${base} (Copy)`
}

/**
 * Clone editable channel fields for duplicate; new id/timestamps/sort order applied by caller.
 * Does not copy analytics, sessions, or primary key.
 */
export function buildDuplicateChannelRecord(sourceRow, { id, sortOrder, nowIso }) {
  const src = migrateStoredChannel(sourceRow)
  const parsed = {
    name: duplicateChannelDisplayName(src.name),
    url: src.url,
    category: src.category,
    bottomTab: src.bottomTab,
    thumbnail: src.thumbnail ?? null,
    isLive: Boolean(src.isLive),
    isHD: Boolean(src.isHD),
    isActive: Boolean(src.isActive),
    showInApp: Boolean(src.showInApp),
    accessType: src.accessType === 'premium' ? 'premium' : 'free',
    backupStream1: src.backupStream1 ?? '',
    backupStream2: src.backupStream2 ?? '',
    origin: src.origin ?? '',
    referer: src.referer ?? '',
    userAgent: src.userAgent ?? '',
    playerType: normalizePlayerType(src.playerType),
    sortOrder: Number(sortOrder) || 0,
  }
  return mergeChannelRecord(null, parsed, id, nowIso)
}

export function mergeChannelRecord(existing, parsed, id, nowIso) {
  const base = existing ? migrateStoredChannel(existing) : {}
  return {
    id,
    name: parsed.name,
    url: parsed.url,
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
    sortOrder:
      parsed.sortOrder != null
        ? Number(parsed.sortOrder) || 0
        : Number(base.sortOrder) || Number(id) || 0,
    channelKind: parsed.channelKind ?? base.channelKind ?? 'standard',
    instructionVisibility: parsed.instructionVisibility ?? base.instructionVisibility ?? 'all',
    isSystemLocked: Boolean(parsed.isSystemLocked ?? base.isSystemLocked),
    instructionVideoUrl: parsed.instructionVideoUrl ?? base.instructionVideoUrl ?? '',
    instructionVideoStatus: parsed.instructionVideoStatus ?? base.instructionVideoStatus ?? '',
    createdAt: base.createdAt || nowIso,
    updatedAt: nowIso,
  }
}

/**
 * Absolute thumbnail/banner image URL for API clients (DB stores `/uploads/...`).
 * When `BUNNY_CDN_BASE_URL` is set, static images are served from Bunny; legacy Render URLs are rewritten.
 */
export function resolveThumbnailForApi(thumbnail, req) {
  return resolvePublicAssetUrl(thumbnail, req)
}

/**
 * Mpingo player.php in WebView: upstream url (not stream-direct HTML proxy).
 * Widevine-only Mpingo rows (empty clearKey) must use Chrome player — WebView lacks Widevine EME (Shaka 6001).
 */
function resolveClientPlaybackFields(m, delivery) {
  const configuredPlayerType = normalizePlayerType(m.playerType)
  const upstream = String(m.url || '').trim()
  const isMpingoPlayer = isMpingoPlayerPageUrl(upstream)

  if ((configuredPlayerType === 'webview' || configuredPlayerType === 'chrome') && isMpingoPlayer) {
    const meta = getCachedMpingoPlayerMetadata(upstream)
    const useChrome = configuredPlayerType === 'chrome' || mpingoNeedsChromePlayer(meta)
    return {
      playbackUrl: upstream,
      stream_delivery_effective: 'upstream',
      playback_source: useChrome ? 'mpingo_chrome_widevine' : 'upstream',
      effectivePlayerType: useChrome ? 'chrome' : configuredPlayerType,
      mpingo_drm: meta
        ? {
            has_clear_key: Boolean(meta.hasClearKey),
            has_stream_url: Boolean(meta.hasStreamUrl),
            stream_type: meta.streamType || null,
          }
        : null,
    }
  }

  return {
    playbackUrl: delivery.playbackUrl,
    stream_delivery_effective: delivery.stream_delivery_effective,
    playback_source: delivery.streamProxy?.playbackSource ?? delivery.stream_delivery_effective,
    effectivePlayerType: configuredPlayerType,
    mpingo_drm: null,
  }
}

/** Public API shape (+ legacy aliases for older clients) */
export function channelToResponse(c, req, clientVersion = 0) {
  const m = migrateStoredChannel({ ...c })
  const instruction = isInstructionVideoChannelRow(m)
  const category = migrateContentCategory(m.category)
  const visibleTabs = parseVisibleTabsFromBottomTabField(m.bottomTab, category)
  const bottomTabCsv = serializeVisibleTabs(visibleTabs)
  const rel = m.thumbnail || null
  const thumbFull = resolveThumbnailForApi(rel, req)

  const isActive = Boolean(m.isActive)
  let showInApp = Boolean(m.showInApp)
  if (instruction) {
    showInApp =
      clientVersion > 0
        ? instructionChannelVisibleForClient(m, clientVersion)
        : Boolean(m.showInApp)
  }
  const instructionPlayback = instruction ? resolveInstructionVideoPlaybackForApi(m, req) : null
  const configuredPlayerType = normalizePlayerType(m.playerType)
  const isDirectHls = configuredPlayerType === 'direct_hls'
  const directHlsUpstream = String(m.url || '').trim()
  const delivery = instruction
    ? {
        playbackUrl: instructionPlayback.full,
        direct_stream_url: instructionPlayback.full,
        stream_delivery_mode: 'direct',
        stream_delivery_effective: 'direct',
        proxy_playback_url: '',
        direct_stream_rollout: null,
        streamProxy: { route: null },
        backupPlayback1: '',
        backupPlayback2: '',
        direct_stream_url_backup1: '',
        direct_stream_url_backup2: '',
      }
    : isDirectHls
      ? {
          playbackUrl: directHlsUpstream,
          direct_stream_url: directHlsUpstream,
          stream_delivery_mode: 'direct',
          stream_delivery_effective: 'direct',
          proxy_playback_url: '',
          direct_stream_rollout: null,
          streamProxy: { route: null },
          backupPlayback1: m.backupStream1 ?? '',
          backupPlayback2: m.backupStream2 ?? '',
          direct_stream_url_backup1: m.backupStream1 ?? '',
          direct_stream_url_backup2: m.backupStream2 ?? '',
        }
      : buildChannelStreamDelivery(req, m)
  const playback = instruction
    ? {
        playbackUrl: delivery.playbackUrl,
        stream_delivery_effective: 'direct',
        playback_source: 'instruction_video',
        effectivePlayerType: 'exo',
        mpingo_drm: null,
      }
    : isDirectHls
      ? {
          playbackUrl: directHlsUpstream,
          stream_delivery_effective: 'direct',
          playback_source: 'direct_hls',
          effectivePlayerType: 'direct_hls',
          mpingo_drm: null,
        }
      : resolveClientPlaybackFields(m, delivery)

  return {
    id: m.id,
    name: m.name,
    url: instruction ? instructionPlayback.relative || instructionPlayback.full : m.url,
    playbackUrl: playback.playbackUrl,
    stream_url: instruction ? instructionPlayback.full : playback.playbackUrl,
    streamUrl: instruction ? instructionPlayback.full : playback.playbackUrl,
    direct_stream_url: delivery.direct_stream_url,
    stream_delivery_mode: delivery.stream_delivery_mode,
    stream_delivery_effective: playback.stream_delivery_effective,
    proxy_playback_url: delivery.proxy_playback_url,
    proxy_fallback_url: delivery.proxy_playback_url,
    direct_stream_rollout: delivery.direct_stream_rollout,
    thumbnail: thumbFull,
    isLive: Boolean(m.isLive),
    isHD: Boolean(m.isHD),
    isActive,
    showInApp,
    is_active: isActive,
    show_in_app: showInApp,
    accessType: instruction ? 'free' : m.accessType === 'premium' ? 'premium' : 'free',
    category,
    bottomTab: bottomTabCsv,
    backupStream1: m.backupStream1 ?? '',
    backupStream2: m.backupStream2 ?? '',
    backupPlayback1: delivery.backupPlayback1,
    backupPlayback2: delivery.backupPlayback2,
    direct_stream_url_backup1: delivery.direct_stream_url_backup1,
    direct_stream_url_backup2: delivery.direct_stream_url_backup2,
    origin: m.origin ?? '',
    referer: m.referer ?? '',
    userAgent: m.userAgent ?? '',
    playerType: playback.effectivePlayerType ?? normalizePlayerType(m.playerType),
    player_type: playback.effectivePlayerType ?? normalizePlayerType(m.playerType),
    player_type_configured: normalizePlayerType(m.playerType),
    use_chrome_player: playback.effectivePlayerType === 'chrome',
    playback_source: playback.playback_source,
    mpingo_drm: playback.mpingo_drm,
    deliveryPath: delivery.streamProxy.route,
    streamProxy: delivery.streamProxy,
    bottomTabsDisplay: bottomTabCsv,
    visibleTabs,
    sortOrder: Number(m.sortOrder) || 0,
    sort_order: Number(m.sortOrder) || 0,
    createdAt: m.createdAt,
    updatedAt: m.updatedAt,
    live: Boolean(m.isLive),
    hd: Boolean(m.isHD),
    active: Boolean(m.isActive),
    accessPremium: instruction ? false : m.accessType === 'premium',
    thumbnailUrl: thumbFull,
    thumbnail_url: thumbFull,
    channelKind: m.channelKind ?? 'standard',
    channel_kind: m.channelKind ?? 'standard',
    instructionVisibility: m.instructionVisibility ?? 'all',
    instruction_visibility: m.instructionVisibility ?? 'all',
    isSystemLocked: Boolean(m.isSystemLocked),
    is_system_locked: Boolean(m.isSystemLocked),
    instructionVideoUrl: instruction ? instructionPlayback.full : (m.instructionVideoUrl ?? ''),
    instruction_video_url: instruction ? instructionPlayback.full : (m.instructionVideoUrl ?? ''),
    instructionVideoStatus: m.instructionVideoStatus ?? '',
    instruction_video_status: m.instructionVideoStatus ?? '',
    ...(instruction ? instructionChannelApiExtras(m, req, clientVersion) : {}),
  }
}

export function uploadsFilePathFromThumbnail(thumbnail) {
  const rel = uploadsRelativePathFromUrl(thumbnail)
  return rel || null
}

export function uploadsRelativePathFromUrl(uploadUrl) {
  const raw = String(uploadUrl ?? '').trim()
  if (!raw) return null
  if (raw.startsWith('/uploads/')) return raw.slice('/uploads/'.length)
  try {
    const parsed = new URL(raw)
    if (parsed.pathname.startsWith('/uploads/')) {
      return parsed.pathname.slice('/uploads/'.length)
    }
  } catch {
    /* ignore */
  }
  return null
}
