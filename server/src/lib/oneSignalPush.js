/**
 * OneSignal REST API — production push (no mock).
 * @see https://documentation.onesignal.com/reference/create-notification
 *
 * Audience (non-all): uses tag filter. Mobile app must set the same tag on devices, e.g.
 *   OneSignal.User.addTag("osmani_audience", "premium")
 * Tag key overridable via ONESIGNAL_AUDIENCE_TAG_KEY (default: osmani_audience).
 * Tag values: premium | trial | inactive (must match admin dropdown).
 *
 * Debug / verification (admin only, separate route): {@link sendOneSignalTestTargetedPush}
 * uses include_subscription_ids or include_player_ids — no segments/filters.
 */

const ONESIGNAL_API = 'https://onesignal.com/api/v1/notifications'

function getConfig() {
  const appId = String(process.env.ONESIGNAL_APP_ID ?? '').trim()
  const restKey = String(process.env.ONESIGNAL_REST_API_KEY ?? process.env.ONESIGNAL_API_KEY ?? '').trim()
  const audienceTagKey = String(process.env.ONESIGNAL_AUDIENCE_TAG_KEY ?? 'osmani_audience').trim() || 'osmani_audience'
  return { appId, restKey, audienceTagKey }
}

export function isOneSignalConfigured() {
  const { appId, restKey } = getConfig()
  return Boolean(appId && restKey)
}

async function postOneSignalCreate(body) {
  const { appId, restKey } = getConfig()
  if (!appId || !restKey) {
    throw new Error(
      'OneSignal is not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY in the server environment.',
    )
  }
  const full = { ...body, app_id: body.app_id ?? appId }
  const res = await fetch(ONESIGNAL_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Key ${restKey}`,
    },
    body: JSON.stringify(full),
  })
  const raw = await res.json().catch(() => ({}))
  if (!res.ok) {
    let errMsg = raw?.error ? String(raw.error) : ''
    if (Array.isArray(raw?.errors)) errMsg = raw.errors.map(String).join('; ')
    else if (raw?.errors && typeof raw.errors === 'object') errMsg = JSON.stringify(raw.errors)
    errMsg =
      errMsg ||
      raw?.invalid_aliases ||
      String(res.statusText || res.status)
    throw new Error(`OneSignal API error (${res.status}): ${errMsg}`)
  }
  const id = raw?.id != null ? String(raw.id) : ''
  if (!id) {
    throw new Error(`OneSignal: missing notification id in response: ${JSON.stringify(raw).slice(0, 500)}`)
  }
  const recipients = Number(raw.recipients ?? raw.successful ?? 0) || 0
  return { id, recipients, raw }
}

/**
 * @param {object} opts
 * @param {string} opts.title
 * @param {string} opts.message
 * @param {string} [opts.url] - deep link e.g. osmani://home
 * @param {string} [opts.imageUrl] - HTTPS public URL for rich image (Android big_picture / iOS attachment)
 * @param {'all'|'premium'|'trial'|'inactive'} opts.audience
 * @returns {Promise<{ id: string, recipients: number, raw: object }>}
 */
export async function sendOneSignalNotification(opts) {
  const { audienceTagKey } = getConfig()

  const title = String(opts.title ?? '').trim()
  const message = String(opts.message ?? '').trim()
  if (!title) throw new Error('OneSignal: title is required')
  if (!message) throw new Error('OneSignal: message is required')

  const audience = String(opts.audience ?? 'all').toLowerCase()
  const url = String(opts.url ?? '').trim() || undefined
  const imageUrl = String(opts.imageUrl ?? '').trim()

  const body = {
    headings: { en: title },
    contents: { en: message },
  }

  if (url) {
    body.url = url
    body.data = { deep_link: url }
  }

  if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
    body.big_picture = imageUrl
    body.chrome_web_image = imageUrl
    body.ios_attachments = { id1: imageUrl }
  }

  if (audience === 'all') {
    body.included_segments = ['Subscribed Users']
  } else {
    const value = audience
    body.filters = [{ field: 'tag', key: audienceTagKey, relation: '=', value }]
  }

  return postOneSignalCreate(body)
}

/**
 * Admin verification only: target explicit subscription/player IDs (no segments, no filters).
 * Prefer subscription IDs (Audience → Users in OneSignal dashboard).
 */
export async function sendOneSignalTestTargetedPush({
  subscriptionIds = [],
  playerIds = [],
  title = 'Osmani admin test',
  message = 'Backend OneSignal delivery test',
  url = 'osmani://home',
}) {
  const subs = (Array.isArray(subscriptionIds) ? subscriptionIds : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  const players = (Array.isArray(playerIds) ? playerIds : [])
    .map((x) => String(x ?? '').trim())
    .filter(Boolean)
  if (subs.length === 0 && players.length === 0) {
    throw new Error('OneSignal test: provide at least one subscriptionId or playerId')
  }

  const body = {
    headings: { en: String(title).trim() || 'Osmani admin test' },
    contents: { en: String(message).trim() || 'Backend OneSignal delivery test' },
  }
  const u = String(url ?? '').trim()
  if (u) {
    body.url = u
    body.data = { deep_link: u }
  }

  if (subs.length > 0) {
    body.include_subscription_ids = subs.slice(0, 2000)
  } else {
    body.include_player_ids = players.slice(0, 2000)
  }

  return postOneSignalCreate(body)
}
