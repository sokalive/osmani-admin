import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { getSubscriptionStatus, postSubscriptionVerify } from '../lib/api'

const DeviceSubscriptionContext = createContext(null)

function normalizeAppModesPayload(body) {
  const payload = body && typeof body === 'object' ? body : {}
  return {
    free_mode: payload.free_mode === true,
    emergency_mode: payload.emergency_mode === true,
    maintenance_mode: payload.maintenance_mode === true,
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
    playbackAllowed: payload.playbackAllowed === true,
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
  const [trackedDeviceId, setTrackedDeviceId] = useState('')
  const [lastOrderId, setLastOrderId] = useState('')

  const applySubscriptionStatusPayload = useCallback((body) => {
    const normalized = normalizeSubscriptionPayload(body)
    setSubscriptionState(normalized)
    return normalized
  }, [])

  const applyAppModesPayload = useCallback((body) => {
    const normalized = normalizeAppModesPayload(body)
    setAppModes(normalized)
    return normalized
  }, [])

  const refreshSubscriptionState = useCallback(
    async ({ deviceId, orderId = '', fingerprint = '' } = {}) => {
      const resolvedDeviceId = String(deviceId ?? trackedDeviceId ?? '').trim()
      const resolvedOrderId = String(orderId ?? lastOrderId ?? '').trim()
      if (!resolvedDeviceId) {
        const cleared = emptySubscriptionState()
        setSubscriptionState(cleared)
        return cleared
      }

      setTrackedDeviceId(resolvedDeviceId)
      setLastOrderId(resolvedOrderId)

      try {
        const body = await postSubscriptionVerify({
          device_id: resolvedDeviceId,
          ...(resolvedOrderId ? { order_id: resolvedOrderId } : {}),
          ...(fingerprint ? { fingerprint: String(fingerprint).trim() } : {}),
        })
        return applySubscriptionStatusPayload(body)
      } catch {
        const body = await getSubscriptionStatus({
          deviceId: resolvedDeviceId,
          orderId: resolvedOrderId,
          fingerprint,
        })
        return applySubscriptionStatusPayload(body)
      }
    },
    [applySubscriptionStatusPayload, lastOrderId, trackedDeviceId],
  )

  const trackSubscriptionDevice = useCallback((deviceId, orderId = '') => {
    setTrackedDeviceId(String(deviceId ?? '').trim())
    setLastOrderId(String(orderId ?? '').trim())
  }, [])

  const clearSubscription = useCallback(() => {
    setSubscriptionState(emptySubscriptionState())
    setTrackedDeviceId('')
    setLastOrderId('')
  }, [])

  const value = useMemo(
    () => ({
      subscriptionState,
      appModes,
      trackedDeviceId,
      lastOrderId,
      isSubscribed: subscriptionState.isActive === true,
      expiresAt: subscriptionState.expiresAt,
      subscriptionStatus: subscriptionState.status,
      blocked: subscriptionState.blocked === true,
      blockReason: subscriptionState.blockReason,
      playbackAllowed: subscriptionState.playbackAllowed === true,
      manualGift: subscriptionState.manualGift,
      plans: subscriptionState.plans,
      applySubscriptionStatusPayload,
      applyAppModesPayload,
      refreshSubscriptionState,
      trackSubscriptionDevice,
      clearSubscription,
    }),
    [
      applyAppModesPayload,
      applySubscriptionStatusPayload,
      appModes,
      clearSubscription,
      lastOrderId,
      refreshSubscriptionState,
      subscriptionState,
      trackedDeviceId,
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
