/**
 * Parse a Google Play Store URL (or bare package id) and fetch listing metadata.
 */

const PLAY_HOST_RE = /(^|\.)play\.google\.com$/i
const PACKAGE_ID_RE = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i

function stripPlayTitleSuffix(title) {
  return String(title ?? '')
    .replace(/\s*[-–—]\s*Apps on Google Play\s*$/i, '')
    .replace(/\s*[-–—]\s*App on Google Play\s*$/i, '')
    .trim()
}

const INVALID_VERSION_RE =
  /^(vary|varies|varies with device|unknown|n\/a|null|undefined)$/i

function normalizePlayVersionName(value) {
  const v = String(value ?? '').trim()
  if (!v || INVALID_VERSION_RE.test(v)) return ''
  if (/^vary$/i.test(v)) return ''
  return v
}

/**
 * @param {string} input
 * @returns {string | null}
 */
export function parsePlayStorePackageId(input) {
  const raw = String(input ?? '').trim()
  if (!raw) return null
  if (PACKAGE_ID_RE.test(raw)) return raw

  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!PLAY_HOST_RE.test(url.hostname.replace(/^www\./i, ''))) return null

  const idParam = String(url.searchParams.get('id') ?? '').trim()
  if (idParam && PACKAGE_ID_RE.test(idParam)) return idParam

  const detailsMatch = url.pathname.match(/\/store\/apps\/details\/([^/?#]+)/i)
  if (detailsMatch?.[1] && PACKAGE_ID_RE.test(detailsMatch[1])) return detailsMatch[1]

  return null
}

function canonicalPlayStoreUrl(packageId) {
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(packageId)}`
}

/**
 * @param {string} html
 * @returns {{ title: string, versionName: string }}
 */
export function parsePlayStoreHtml(html) {
  const body = String(html ?? '')
  let title = ''
  const ogTitle =
    body.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
    body.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)
  if (ogTitle?.[1]) title = stripPlayTitleSuffix(ogTitle[1])

  if (!title) {
    const docTitle = body.match(/<title[^>]*>([^<]+)<\/title>/i)
    if (docTitle?.[1]) title = stripPlayTitleSuffix(docTitle[1])
  }

  let versionName = ''
  const versionPatterns = [
    /itemprop=["']version["'][^>]+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["'][^>]+itemprop=["']version["']/i,
    /"softwareVersion"\s*:\s*"([^"]+)"/i,
    /Current Version[^>]*>[\s\S]{0,400}?>([\d]+(?:\.[\d]+)*[a-zA-Z0-9.-]*)</i,
  ]
  for (const re of versionPatterns) {
    const m = body.match(re)
    if (m?.[1]) {
      versionName = String(m[1]).trim()
      break
    }
  }

  return { title, versionName }
}

async function fetchPlayStoreHtml(packageId) {
  const url = `${canonicalPlayStoreUrl(packageId)}&hl=en&gl=us`
  const res = await fetch(url, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
      Accept: 'text/html,application/xhtml+xml',
    },
    redirect: 'follow',
  })
  if (!res.ok) {
    throw new Error(`Play Store returned HTTP ${res.status}`)
  }
  return res.text()
}

async function fetchViaGooglePlayScraper(packageId) {
  try {
    const gplay = await import('google-play-scraper')
    const app = await gplay.default.app({ appId: packageId, lang: 'en', country: 'us' })
    return {
      title: stripPlayTitleSuffix(app?.title ?? ''),
      versionName: normalizePlayVersionName(app?.version),
      playstoreUrl: canonicalPlayStoreUrl(packageId),
      packageId,
    }
  } catch (e) {
    console.warn('[playStoreMetadata] google-play-scraper failed:', e?.message || e)
    return null
  }
}

/**
 * @param {string} input Play Store URL or package id
 * @returns {Promise<{ packageId: string, title: string, versionName: string, playstoreUrl: string }>}
 */
export async function fetchPlayStoreMetadata(input) {
  const packageId = parsePlayStorePackageId(input)
  if (!packageId) {
    throw new Error('Invalid Google Play Store URL or package id')
  }

  const scraperResult = await fetchViaGooglePlayScraper(packageId)
  if (scraperResult?.title && scraperResult?.versionName) {
    return scraperResult
  }
  if (scraperResult?.title) {
    const html = await fetchPlayStoreHtml(packageId)
    const parsed = parsePlayStoreHtml(html)
    const versionName = normalizePlayVersionName(
      scraperResult.versionName || parsed.versionName,
    )
    return {
      ...scraperResult,
      versionName,
    }
  }

  const html = await fetchPlayStoreHtml(packageId)
  const parsed = parsePlayStoreHtml(html)
  const title = scraperResult?.title || parsed.title
  const versionName = normalizePlayVersionName(
    scraperResult?.versionName || parsed.versionName,
  )

  if (!title) {
    throw new Error('Could not read app title from Play Store listing')
  }

  return {
    packageId,
    title,
    versionName,
    playstoreUrl: canonicalPlayStoreUrl(packageId),
  }
}
