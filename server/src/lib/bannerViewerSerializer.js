import { normalizeRuntimePosition } from './bannerRuntimePosition.js'

const VIEWER_BADGE_POSITION = 'top_left'

/**
 * Public APK/WebView viewer serializer for GET /api/banners.
 * Older clients derive green (daily timer) and blue (countdown) overlay pills from
 * event_timer / enable_countdown — force those off so only the red COMING SOON pill remains.
 *
 * @param {Record<string, unknown> | null | undefined} banner
 * @returns {Record<string, unknown> | null}
 */
export function enrichBannersForViewer(banner) {
  if (!banner || typeof banner !== 'object') return banner ?? null

  return {
    ...banner,
    enable_countdown: false,
    enableCountdown: false,
    event_timer: false,
    eventTimer: false,
    useTimer: false,
    show_green_badge: false,
    showGreenBadge: false,
    show_blue_badge: false,
    showBlueBadge: false,
    show_red_badge: true,
    showRedBadge: true,
    badge_position: VIEWER_BADGE_POSITION,
    badgePosition: VIEWER_BADGE_POSITION,
    runtime_position: normalizeRuntimePosition(
      banner.runtime_position ?? banner.runtimePosition,
    ),
    runtimePosition: normalizeRuntimePosition(
      banner.runtime_position ?? banner.runtimePosition,
    ),
    viewer_serializer: 2,
    viewerSerializer: 2,
  }
}

/**
 * @param {Array<Record<string, unknown>>} banners
 */
export function enrichBannersListForViewer(banners) {
  if (!Array.isArray(banners)) return []
  return banners.map((b) => enrichBannersForViewer(b)).filter(Boolean)
}
