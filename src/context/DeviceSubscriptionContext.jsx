import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  getAppGlobalSettings,
  getPublicRuntimeAppModes,
  getSubscriptionStatus,
  postSubscriptionVerify,
  subscriptionStreamUrl,
} from '../lib/api'

const DeviceSubscriptionContext = createContext(null)

function normalizeAppModesPayload(body) {
  const payload = body && typeof body === 'object' ? body : {}
  return {
    free_mode: payload.free_mode === true || payload.freeMode === true,
    emergency_mode: payload.emergency_mode === true || payload.emergencyMode === true,
    maintenance_mode: payload.maintenance_mode === true || payload.maintenanceMode === true,
    v: payload.v != null ? Number(payload.v) || 0 : 0,
    server_time_ms: payload.server_time_ms != null ? Number(payload.server_time_ms) || null : null,
    reason: payload.reason != null ? String(payload.reason) : null,
    ok: payload.ok !== false,
  }
}

function normalizeSubscriptionPayload(body) {
  const payload = body && typeof body === 'object' ? body : {}
  const active = payload.active === true || payload.isActive === true
  const expiresAt = payload.expiresAt ?? payload.expires_at ?? null
  const status = payload.status != null ? String(payload.status) : null
  const blocked = payload.blocked === true
  const plans = Array.isArray(payload.plans)
    ? payload.plans.map((plan) => ({
        id: Number(plan?.id),
        name: String(plan?.name ?? ''),
        price: Number(plan?.price) || 0,
        duration_days: Number(plan?.duration_days) || 0,
      }))
    : []
  const manualGift =
    payload.manualGift && typeof payload.manualGift === 'object'
      ? {
          showPopup: payload.manualGift.showPopup === true,
          nonce: payload.manualGift.nonce != null ? String(payload.manualGift.nonce) : null,
          grantId: payload.manualGift.grantId != null ? Number(payload.manualGift.grantId) || null : null,
          durationDays:
            payload.manualGift.durationDays != null ? Number(payload.manualGift.durationDays) || null : null,
          title: payload.manualGift.title != null ? String(payload.manualGift.title) : '',
          body: payload.manualGift.body != null ? String(payload.manualGift.body) : '',
          ctaLabel: payload.manualGift.ctaLabel != null ? String(payload.manualGift.ctaLabel) : '',
        }
      : null

  const remSec = Number(payload.remainingSeconds ?? payload.remaining_seconds ?? 0)
  const remHr = Number(payload.remainingHours ?? payload.remaining_hours ?? 0)
  const remDay = Number(payload.remainingDays ?? payload.remaining_days ?? 0)
  const safeSec = Number.isFinite(remSec) && remSec > 0 ? Math.floor(remSec) : 0
  const safeHr = Number.isFinite(remHr) && remHr > 0 ? Math.floor(remHr) : 0
  const safeDay = Number.isFinite(remDay) && remDay > 0 ? Math.floor(remDay) : 0
  const nearExpiry = payload.nearExpiry === true || payload.near_expiry === true

  return {
    active,
    isActive: active,
    status,
    expiresAt: expiresAt != null ? String(expiresAt) : null,
    expires_at: expiresAt != null ? String(expiresAt) : null,
    blocked,
    blockReason: payload.blockReason != null ? String(payload.blockReason) : null,
    amount: payload.amount != null ? Number(payload.amount) : null,
    currency: payload.currency != null ? String(payload.currency) || null : null,
    plan_duration_days:
      payload.plan_duration_days != null ? Number(payload.plan_duration_days) || 0 : null,
    planDurationDays:
      payload.planDurationDays != null
        ? Number(payload.planDurationDays) || 0
        : payload.plan_duration_days != null
          ? Number(payload.plan_duration_days) || 0
          : null,
    manualGift,
    remainingSeconds: safeSec,
    remaining_seconds: safeSec,
    remainingHours: safeHr,
    remaining_hours: safeHr,
    remainingDays: safeDay,
    remaining_days: safeDay,
    nearExpiry,
    near_expiry: nearExpiry,
    playbackAllowed: payload.playbackAllowed === true,
    playbackGateReason: payload.playbackGateReason != null ? String(payload.playbackGateReason) : null,
    plans,
  }
}

function emptySubscriptionState() {
  return normalizeSubscriptionPayload({})
}

function emptyAppModesState() {
  return normalizeAppModesPayload({})
}

/** Global unlock state — mirror in React Native with your realtime client + this shape. */
export function DeviceSubscriptionProvider({ children }) {
  const [subscriptionState, setSubscriptionState] = useState(() => emptySubscriptionState())
  const [appModes, setAppModes] = useState(() => emptyAppModesState())
  const [appModesReady, setAppModesReady] = useState(false)
  const [trackedDeviceId, setTrackedDeviceId] = useState('')
  const [trackedFingerprint, setTrackedFingerprint] = useState('')
  const [lastOrderId, setLastOrderId] = useState('')

  const applySubscriptionStatusPayload = useCallback((body) => {
    const normalized = normalizeSubscriptionPayload(body)
    setSubscriptionState(normalized)
    const runtimeModes = body?.app_modes ?? body
    if (
      runtimeModes &&
      typeof runtimeModes === 'object' &&
      ('free_mode' in runtimeModes ||
        'emergency_mode' in runtimeModes ||
        'maintenance_mode' in runtimeModes ||
        'freeMode' in runtimeModes ||
        'emergencyMode' in runtimeModes ||
        'maintenanceMode' in runtimeModes)
    ) {
      setAppModes(normalizeAppModesPayload(runtimeModes))
      setAppModesReady(true)
    }
    return normalized
  }, [])

  const applyAppModesPayload = useCallback((body) => {
    const normalized = normalizeAppModesPayload(body)
    setAppModes(normalized)
    setAppModesReady(true)
    return normalized
  }, [])

  useEffect(() => {
    const id = window.setInterval(() => {
      void getPublicRuntimeAppModes()
        .then((body) => applyAppModesPayload(body))
        .catch(() => {})
    }, 10_000)
    return () => window.clearInterval(id)
  }, [applyAppModesPayload])

  const refreshAppModes = useCallback(async () => {
    const body = await getAppGlobalSettings()
    return applyAppModesPayload(body)
  }, [applyAppModesPayload])

  const refreshSubscriptionState = useCallback(
    async ({ deviceId, orderId = '', fingerprint = '' } = {}) => {
      const resolvedDeviceId = String(deviceId ?? trackedDeviceId ?? '').trim()
      const resolvedOrderId = String(orderId ?? lastOrderId ?? '').trim()
      const resolvedFingerprint = String(fingerprint ?? trackedFingerprint ?? '').trim()
      if (!resolvedDeviceId) {
        const cleared = emptySubscriptionState()
        setSubscriptionState(cleared)
        return cleared
      }

      setTrackedDeviceId(resolvedDeviceId)
      setLastOrderId(resolvedOrderId)
      setTrackedFingerprint(resolvedFingerprint)

      try {
        const body = await postSubscriptionVerify({
          device_id: resolvedDeviceId,
          ...(resolvedOrderId ? { order_id: resolvedOrderId } : {}),
          ...(resolvedFingerprint ? { fingerprint: resolvedFingerprint } : {}),
        })
        return applySubscriptionStatusPayload(body)
      } catch {
        const body = await getSubscriptionStatus({
          deviceId: resolvedDeviceId,
          orderId: resolvedOrderId,
          fingerprint: resolvedFingerprint,
        })
        return applySubscriptionStatusPayload(body)
      }
    },
    [applySubscriptionStatusPayload, lastOrderId, trackedDeviceId, trackedFingerprint],
  )

  const trackSubscriptionDevice = useCallback((input, orderId = '', fingerprint = '') => {
    if (input && typeof input === 'object') {
      setTrackedDeviceId(String(input.deviceId ?? '').trim())
      setLastOrderId(String(input.orderId ?? '').trim())
      setTrackedFingerprint(String(input.fingerprint ?? '').trim())
      return
    }
    setTrackedDeviceId(String(input ?? '').trim())
    setLastOrderId(String(orderId ?? '').trim())
    setTrackedFingerprint(String(fingerprint ?? '').trim())
  }, [])

  const clearSubscription = useCallback(() => {
    setSubscriptionState(emptySubscriptionState())
    setTrackedDeviceId('')
    setLastOrderId('')
    setTrackedFingerprint('')
  }, [])

  useEffect(() => {
    if (!trackedDeviceId) return undefined
    let cancelled = false
    let es = null

    async function refreshRuntimeState(trigger) {
      if (cancelled) return
      try {
        await refreshSubscriptionState({
          deviceId: trackedDeviceId,
          orderId: lastOrderId,
          fingerprint: trackedFingerprint,
        })
      } catch {
        if (trigger === 'poll') {
          /* keep fallback polling */
        }
      }
    }

    try {
      es = new EventSource(subscriptionStreamUrl(trackedDeviceId, { fingerprint: trackedFingerprint }))
      es.addEventListener('snapshot', () => {
        void refreshRuntimeState('snapshot')
      })
      es.addEventListener('device_subscription', () => {
        void refreshRuntimeState('device_subscription')
      })
      es.addEventListener('app_modes', (ev) => {
        try {
          applyAppModesPayload(JSON.parse(ev.data))
        } catch {
          /* ignore malformed app_modes */
        }
      })
    } catch {
      /* EventSource unsupported */
    }

    void refreshRuntimeState('init')
    const pollId = window.setInterval(() => {
      void refreshRuntimeState('poll')
    }, 3000)

    return () => {
      cancelled = true
      window.clearInterval(pollId)
      es?.close()
    }
  }, [applyAppModesPayload, lastOrderId, refreshSubscriptionState, trackedDeviceId, trackedFingerprint])

  const value = useMemo(
    () => ({
      subscriptionState,
      appModes,
      appModesReady,
      trackedDeviceId,
      trackedFingerprint,
      lastOrderId,
      isSubscribed: subscriptionState.isActive === true,
      expiresAt: subscriptionState.expiresAt,
      subscriptionStatus: subscriptionState.status,
      blocked: subscriptionState.blocked === true,
      blockReason: subscriptionState.blockReason,
      playbackAllowed: subscriptionState.playbackAllowed === true,
      playbackGateReason: subscriptionState.playbackGateReason,
      manualGift: subscriptionState.manualGift,
      plans: subscriptionState.plans,
      applySubscriptionStatusPayload,
      applyAppModesPayload,
      refreshAppModes,
      refreshSubscriptionState,
      trackSubscriptionDevice,
      clearSubscription,
    }),
    [
      applyAppModesPayload,
      applySubscriptionStatusPayload,
      appModes,
      appModesReady,
      clearSubscription,
      lastOrderId,
      refreshAppModes,
      refreshSubscriptionState,
      subscriptionState,
      trackedDeviceId,
      trackedFingerprint,
      trackSubscriptionDevice,
    ],
  )

  return (
    <DeviceSubscriptionContext.Provider value={value}>{children}</DeviceSubscriptionContext.Provider>
  )
}

export function useDeviceSubscription() {
  const ctx = useContext(DeviceSubscriptionContext)
  if (!ctx) {
    throw new Error('useDeviceSubscription must be used within DeviceSubscriptionProvider')
  }
  return ctx
}
