/**
 * OneSignal REST API — production push (no mock).
 * @see https://documentation.onesignal.com/reference/create-notification
 *
 * Audience (non-all): uses tag filter. Mobile app must set the same tag on devices, e.g.
 *   OneSignal.User.addTag("osmani_audience", "premium")
 * Tag key overridable via ONESIGNAL_AUDIENCE_TAG_KEY (default: osmani_audience).
 * Tag values: premium | trial | inactive (must match admin dropdown).
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
  const { appId, restKey, audienceTagKey } = getConfig()
  if (!appId || !restKey) {
    throw new Error(
      'OneSignal is not configured. Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY in the server environment.',
    )
  }

  const title = String(opts.title ?? '').trim()
  const message = String(opts.message ?? '').trim()
  if (!title) throw new Error('OneSignal: title is required')
  if (!message) throw new Error('OneSignal: message is required')

  const audience = String(opts.audience ?? 'all').toLowerCase()
  const url = String(opts.url ?? '').trim() || undefined
  const imageUrl = String(opts.imageUrl ?? '').trim()

  const body = {
    app_id: appId,
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

  const res = await fetch(ONESIGNAL_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Key ${restKey}`,
    },
    body: JSON.stringify(body),
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
