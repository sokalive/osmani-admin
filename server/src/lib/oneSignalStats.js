/**
 * OneSignal per-message analytics (View message API).
 * @see https://documentation.onesignal.com/reference/view-message
 */

import { getOneSignalConfig, isOneSignalConfigured } from './oneSignalPush.js'

const ONESIGNAL_API_BASE = 'https://api.onesignal.com'

/**
 * @param {string} messageId - OneSignal notification UUID from create response
 */
export async function fetchOneSignalMessageStats(messageId) {
  const id = String(messageId ?? '').trim()
  if (!id) throw new Error('OneSignal message id is required')

  const { appId, restKey } = getOneSignalConfig()
  if (!appId || !restKey) {
    throw new Error('OneSignal is not configured')
  }

  // View Message API only — do not pass outcome_names (requires paid custom-outcome plan).
  const url = new URL(`${ONESIGNAL_API_BASE}/notifications/${encodeURIComponent(id)}`)
  url.searchParams.set('app_id', appId)

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Key ${restKey}` },
  })
  const raw = await res.json().catch(() => ({}))
  if (!res.ok) {
    const err =
      (Array.isArray(raw?.errors) && raw.errors.map(String).join('; ')) ||
      String(raw?.error || res.status)
    throw new Error(`OneSignal stats error (${res.status}): ${err}`)
  }
  return raw
}

function unixToIso(sec) {
  const n = Number(sec)
  if (!Number.isFinite(n) || n <= 0) return null
  return new Date(n * 1000).toISOString()
}

/**
 * Map OneSignal message fields into payload keys stored on notifications.
 */
export function normalizeOneSignalStatsPayload(raw, existingPayload = {}) {
  const successful = Math.max(0, Number(raw?.successful) || 0)
  const received = Math.max(0, Number(raw?.received) || 0)
  const failed = Math.max(0, Number(raw?.failed) || 0)
  const errored = Math.max(0, Number(raw?.errored) || 0)
  const clicked = Math.max(0, Number(raw?.converted) || 0)
  const delivered = successful
  const ctr =
    delivered > 0 ? Math.round((clicked / delivered) * 10000) / 100 : clicked > 0 ? 100 : 0

  const onesignalSentAt =
    unixToIso(raw?.completed_at) ||
    unixToIso(raw?.send_after) ||
    unixToIso(raw?.queued_at) ||
    (existingPayload.onesignal_sent_at != null ? String(existingPayload.onesignal_sent_at) : null)

  return {
    onesignal_id: raw?.id != null ? String(raw.id) : existingPayload.onesignal_id ?? null,
    onesignal_delivered: delivered,
    onesignal_confirmed: received,
    onesignal_failed: failed,
    onesignal_errored: errored,
    onesignal_clicked: clicked,
    onesignal_ctr: ctr,
    onesignal_sent_at: onesignalSentAt,
    onesignal_stats_synced_at: new Date().toISOString(),
    onesignal_remaining:
      raw?.remaining != null && raw.remaining !== '' ? Number(raw.remaining) : null,
  }
}

export function extractOneSignalStatsFromPayload(p) {
  const payload = p && typeof p === 'object' ? p : {}
  const num = (k) => {
    const v = payload[k]
    if (v == null || v === '') return null
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return {
    onesignalId: payload.onesignal_id != null ? String(payload.onesignal_id) : null,
    delivered: num('onesignal_delivered'),
    confirmed: num('onesignal_confirmed'),
    failed: num('onesignal_failed'),
    errored: num('onesignal_errored'),
    clicked: num('onesignal_clicked'),
    ctr: num('onesignal_ctr'),
    sentAt: payload.onesignal_sent_at != null ? String(payload.onesignal_sent_at) : null,
    statsSyncedAt:
      payload.onesignal_stats_synced_at != null ? String(payload.onesignal_stats_synced_at) : null,
    recipients: num('onesignal_recipients'),
  }
}
