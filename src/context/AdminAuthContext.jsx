import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getAdminAuthMe, getAdminAuthStatus, postAdminLogout, postAdminRefreshSession } from '../lib/api'
import {
  adminJwtNeedsRefresh,
  clearAdminSession,
  getAdminSessionEmail,
  getAdminSessionToken,
  PENDING_EMAIL_KEY,
  PENDING_OTP_KEY,
  setAdminSessionEmail,
  setAdminSessionToken,
} from '../lib/adminSessionStorage'

const AdminAuthContext = createContext(null)

export function AdminAuthProvider({ children }) {
  const [ready, setReady] = useState(false)
  const [panelAuthRequired, setPanelAuthRequired] = useState(false)
  const [token, setTokenState] = useState(() => getAdminSessionToken())
  const [email, setEmail] = useState(() => getAdminSessionEmail())
  const [sessionChecked, setSessionChecked] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const d = await getAdminAuthStatus()
      setPanelAuthRequired(d?.panelAuthRequired === true)
    } catch {
      setPanelAuthRequired(false)
    } finally {
      setReady(true)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  useEffect(() => {
    const onStorage = () => {
      setTokenState(getAdminSessionToken())
      setEmail(getAdminSessionEmail())
    }
    window.addEventListener('osmani-admin-auth', onStorage)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('osmani-admin-auth', onStorage)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setSession = useCallback((t, em) => {
    setAdminSessionToken(t ?? null)
    setAdminSessionEmail(em ?? null)
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.removeItem(PENDING_OTP_KEY)
      sessionStorage.removeItem(PENDING_EMAIL_KEY)
    }
    setTokenState(t ?? null)
    setEmail(em ?? null)
    window.dispatchEvent(new Event('osmani-admin-auth'))
  }, [])

  const setPendingOtp = useCallback((pendingToken, em) => {
    if (typeof sessionStorage === 'undefined') return
    if (pendingToken) sessionStorage.setItem(PENDING_OTP_KEY, pendingToken)
    else sessionStorage.removeItem(PENDING_OTP_KEY)
    if (em) sessionStorage.setItem(PENDING_EMAIL_KEY, em)
    else sessionStorage.removeItem(PENDING_EMAIL_KEY)
  }, [])

  const logout = useCallback(() => {
    void postAdminLogout().catch(() => {})
    clearAdminSession()
    setTokenState(null)
    setEmail(null)
    setSessionChecked(true)
    window.dispatchEvent(new Event('osmani-admin-auth'))
  }, [])

  useEffect(() => {
    let cancelled = false
    if (!ready) return undefined
    if (!panelAuthRequired || !token) {
      setSessionChecked(true)
      return undefined
    }
    setSessionChecked(false)

    async function validateSession() {
      try {
        if (adminJwtNeedsRefresh(token)) {
          const refreshed = await postAdminRefreshSession()
          if (refreshed?.ok === true && refreshed.token) {
            setSession(refreshed.token, refreshed.email || getAdminSessionEmail())
          }
        }
        const me = await getAdminAuthMe()
        if (cancelled) return
        if (!me || me.ok !== true) {
          logout()
          return
        }
        const nextEmail = String(me.email ?? '').trim()
        if (nextEmail) {
          setAdminSessionEmail(nextEmail)
          setEmail(nextEmail)
        }
      } catch {
        if (!cancelled) logout()
      } finally {
        if (!cancelled) setSessionChecked(true)
      }
    }

    void validateSession()
    return () => {
      cancelled = true
    }
  }, [ready, panelAuthRequired, token, logout, setSession])

  const value = useMemo(
    () => ({
      ready,
      sessionChecked,
      panelAuthRequired,
      token,
      email,
      setSession,
      setPendingOtp,
      logout,
      refreshStatus,
    }),
    [ready, sessionChecked, panelAuthRequired, token, email, setSession, setPendingOtp, logout, refreshStatus],
  )

  return <AdminAuthContext.Provider value={value}>{children}</AdminAuthContext.Provider>
}

export function useAdminAuth() {
  const ctx = useContext(AdminAuthContext)
  if (!ctx) throw new Error('useAdminAuth must be used within AdminAuthProvider')
  return ctx
}

export function getPendingOtpToken() {
  return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(PENDING_OTP_KEY) : null
}

export function getPendingOtpEmail() {
  return typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(PENDING_EMAIL_KEY) : null
}
