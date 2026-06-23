/**
 * Read-only OneSignal User Model diagnostics (no send, no subscription ID targeting).
 * @see https://documentation.onesignal.com/reference/view-an-app
 * @see https://documentation.onesignal.com/reference/view-segments
 */

import { buildProductionOneSignalBody, getOneSignalConfig } from './oneSignalPush.js'

const ONESIGNAL_API_BASE = 'https://api.onesignal.com'

async function oneSignalGet(path, restKey) {
  const res = await fetch(`${ONESIGNAL_API_BASE}${path}`, {
    method: 'GET',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      Authorization: `Key ${restKey}`,
    },
  })
  const raw = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, raw }
}

/**
 * @returns {Promise<object>}
 */
export async function fetchOneSignalSubscriptionDiagnostics() {
  const { appId, restKey } = getOneSignalConfig()
  if (!appId || !restKey) {
    return {
      configured: false,
      error: 'Set ONESIGNAL_APP_ID and ONESIGNAL_REST_API_KEY on the server.',
    }
  }

  const productionSegment = 'Total Subscriptions'
  const backendBroadcastBody = buildProductionOneSignalBody({
    appId,
    title: 'Diagnostic title',
    message: 'Diagnostic message',
  })

  const dashboardReferenceBody = {
    app_id: appId,
    included_segments: [productionSegment],
    target_channel: 'push',
    contents: { en: 'Hello, world' },
  }

  const out = {
    configured: true,
    appId,
    productionSegment,
    api: {
      viewApp: `${ONESIGNAL_API_BASE}/apps/${appId}`,
      viewSegments: `${ONESIGNAL_API_BASE}/apps/${appId}/segments`,
      createNotification: `${ONESIGNAL_API_BASE}/notifications`,
    },
    backendBroadcastRequest: {
      method: 'POST',
      url: `${ONESIGNAL_API_BASE}/notifications`,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: 'Key [REDACTED]',
      },
      body: backendBroadcastBody,
    },
    dashboardReferenceRequest: {
      note:
        'Official OneSignal curl example includes target_channel for push; push notification schema marks target_channel as required for include_aliases only, not for included_segments alone.',
      body: dashboardReferenceBody,
      bodyDiffersFromBackend: JSON.stringify(backendBroadcastBody) !== JSON.stringify(dashboardReferenceBody),
    },
    app: null,
    segments: [],
    subscribedUsersSegment: null,
    analysis: [],
    clientSdkChecklist: [
      'After app startup: OneSignal.login(externalId) must run if you rely on external_id (does not replace push opt-in).',
      'Push permission: user must accept the OS notification permission prompt (not only appear in Audience).',
      'Subscription status in dashboard: User → Subscriptions → Push row must be Subscribed (not Unsubscribed / Never Subscribed).',
      'Android: confirm FCM is configured on the same OneSignal app_id as ONESIGNAL_APP_ID on Render.',
      'Verify ONESIGNAL_APP_ID in Render matches the app where dashboard test pushes succeed.',
      'User Model: Audience → Users counts users; API broadcast with push channel needs at least one subscribed Push subscription.',
    ],
  }

  const appRes = await oneSignalGet(`/apps/${encodeURIComponent(appId)}`, restKey)
  if (appRes.ok) {
    out.app = {
      id: appRes.raw?.id,
      name: appRes.raw?.name,
      players: appRes.raw?.players,
      messageable_players: appRes.raw?.messageable_players,
      apns_env: appRes.raw?.apns_env,
      fcm_sender_id: appRes.raw?.fcm_sender_id ? '[set]' : null,
      organization_id: appRes.raw?.organization_id,
    }
  } else {
    out.app = { error: appRes.raw, httpStatus: appRes.status }
    out.analysis.push(
      `Could not read app metadata (HTTP ${appRes.status}). If using Organization API key only, use the App REST API key from Keys & IDs.`,
    )
  }

  const segListRes = await oneSignalGet(`/apps/${encodeURIComponent(appId)}/segments?limit=50`, restKey)
  if (segListRes.ok && Array.isArray(segListRes.raw?.segments)) {
    out.segments = segListRes.raw.segments.map((s) => ({
      id: s.id,
      name: s.name,
      is_active: s.is_active,
      read_only: s.read_only,
    }))
    const subSeg = segListRes.raw.segments.find((s) => s.name === productionSegment)
    if (subSeg?.id) {
      const detailRes = await oneSignalGet(
        `/apps/${encodeURIComponent(appId)}/segments/${encodeURIComponent(subSeg.id)}?include-segment-detail=true`,
        restKey,
      )
      if (detailRes.ok) {
        out.subscribedUsersSegment = {
          id: subSeg.id,
          name: subSeg.name,
          subscriber_count: detailRes.raw?.subscriber_count,
          source: detailRes.raw?.payload?.source,
          filters: detailRes.raw?.payload?.filters,
        }
      } else {
        out.subscribedUsersSegment = {
          id: subSeg.id,
          name: subSeg.name,
          error: detailRes.raw,
          httpStatus: detailRes.status,
        }
      }
    } else {
      out.analysis.push(
        `Segment "${productionSegment}" not found in app. Create it in OneSignal or set a matching default segment name.`,
      )
    }
  } else {
    out.segments = { error: segListRes.raw, httpStatus: segListRes.status }
  }

  const messageable = Number(out.app?.messageable_players ?? 0)
  const segCount = Number(out.subscribedUsersSegment?.subscriber_count ?? 0)

  if (messageable === 0) {
    out.analysis.push(
      'messageable_players is 0: OneSignal has no push-eligible subscriptions on this app_id. Users in Audience without a Subscribed Push subscription cannot receive API broadcasts.',
    )
  } else if (segCount === 0) {
    out.analysis.push(
      `"${productionSegment}" subscriber_count is 0: segment is empty for this app even though total players may exist.`,
    )
  } else if (messageable > 0 && segCount > 0) {
    out.analysis.push(
      `App reports ${messageable} messageable subscription(s) and "${productionSegment}" has ${segCount} subscriber(s). If sends still fail, open a user in Audience and confirm a Push subscription row is Subscribed (not email-only).`,
    )
  }

  out.analysis.push(
    'Backend broadcast includes target_channel: push with included_segments (matches OneSignal create-message API).',
  )

  return out
}
