/** Mpingo player.php HTML served via stream-direct/proxy needs <base href> for relative URLs. */

export function isMpingoPlayerPageUrl(rawUrl) {
  try {
    const u = new URL(String(rawUrl || ''))
    const host = u.hostname.toLowerCase()
    if (host !== 'mpingotv.com' && !host.endsWith('.mpingotv.com')) return false
    return /\/player\.php$/i.test(u.pathname)
  } catch {
    return false
  }
}

/** Directory base for player.php (e.g. …/v3/player.php → …/v3/). */
export function resolveMpingoHtmlBaseHref(rawUrl) {
  if (!isMpingoPlayerPageUrl(rawUrl)) return null
  return new URL('./', String(rawUrl)).href
}

const MPINGO_BASE_MARKER = 'data-osmani-mpingo-base="1"'

/**
 * Inject <base href> so subscriptions.php, assets/, etc. resolve on nur.mpingotv.com.
 * @param {string} html
 * @param {string} upstreamUrl
 */
export function injectMpingoHtmlBaseHref(html, upstreamUrl) {
  const baseHref = resolveMpingoHtmlBaseHref(upstreamUrl)
  if (!baseHref) return String(html ?? '')
  const text = String(html ?? '')
  if (!/<head\b/i.test(text)) return text
  if (text.includes(MPINGO_BASE_MARKER)) return text

  const tag = `<base href="${baseHref}" ${MPINGO_BASE_MARKER}>`
  if (/<base\s/i.test(text)) {
    return text.replace(/<base\s[^>]*>/i, tag)
  }
  return text.replace(/<head([^>]*)>/i, `<head$1>${tag}`)
}
