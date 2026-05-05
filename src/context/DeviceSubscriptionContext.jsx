import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const DeviceSubscriptionContext = createContext(null)

/** Global unlock state — mirror in React Native with your realtime client + this shape. */
export function DeviceSubscriptionProvider({ children }) {
  const [isSubscribed, setIsSubscribed] = useState(false)
  const [expiresAt, setExpiresAt] = useState(null)

  const applySubscriptionStatusPayload = useCallback((body) => {
    const active = body?.active === true || body?.isActive === true
    const exp = body?.expiresAt != null ? String(body.expiresAt) : null
    if (active) {
      setIsSubscribed(true)
      setExpiresAt(exp)
    }
  }, [])

  const clearSubscription = useCallback(() => {
    setIsSubscribed(false)
    setExpiresAt(null)
  }, [])

  const value = useMemo(
    () => ({
      isSubscribed,
      expiresAt,
      applySubscriptionStatusPayload,
      clearSubscription,
    }),
    [applySubscriptionStatusPayload, clearSubscription, expiresAt, isSubscribed],
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
