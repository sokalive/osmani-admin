import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { getAdminAuthStatus } from '../lib/api'

const TOKEN_KEY = 'osmani_admin_token'
const PENDING_OTP_KEY = 'osmani_admin_pending_otp_token'
const PENDING_EMAIL_KEY = 'osmani_admin_pending_email'

const AdminAuthContext = createContext(null)

export function AdminAuthProvider({ children }) {
  const [ready, setReady] = useState(false)
  const [panelAuthRequired, setPanelAuthRequired] = useState(false)
  const [token, setTokenState] = useState(() =>
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(TOKEN_KEY) : null,
  )
  const [email, setEmail] = useState(() =>
    typeof sessionStorage !== 'undefined' ? sessionStorage.getItem('osmani_admin_email') : null,
  )

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
      setTokenState(sessionStorage.getItem(TOKEN_KEY))
      setEmail(sessionStorage.getItem('osmani_admin_email'))
    }
    window.addEventListener('osmani-admin-auth', onStorage)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener('osmani-admin-auth', onStorage)
      window.removeEventListener('storage', onStorage)
    }
  }, [])

  const setSession = useCallback((t, em) => {
    if (t) sessionStorage.setItem(TOKEN_KEY, t)
    else sessionStorage.removeItem(TOKEN_KEY)
    if (em) sessionStorage.setItem('osmani_admin_email', em)
    else sessionStorage.removeItem('osmani_admin_email')
    sessionStorage.removeItem(PENDING_OTP_KEY)
    sessionStorage.removeItem(PENDING_EMAIL_KEY)
    setTokenState(t ?? null)
    setEmail(em ?? null)
    window.dispatchEvent(new Event('osmani-admin-auth'))
  }, [])

  const setPendingOtp = useCallback((pendingToken, em) => {
    if (pendingToken) sessionStorage.setItem(PENDING_OTP_KEY, pendingToken)
    else sessionStorage.removeItem(PENDING_OTP_KEY)
    if (em) sessionStorage.setItem(PENDING_EMAIL_KEY, em)
    else sessionStorage.removeItem(PENDING_EMAIL_KEY)
  }, [])

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY)
    sessionStorage.removeItem('osmani_admin_email')
    sessionStorage.removeItem(PENDING_OTP_KEY)
    sessionStorage.removeItem(PENDING_EMAIL_KEY)
    setTokenState(null)
    setEmail(null)
    window.dispatchEvent(new Event('osmani-admin-auth'))
  }, [])

  const value = useMemo(
    () => ({
      ready,
      panelAuthRequired,
      token,
      email,
      setSession,
      setPendingOtp,
      logout,
      refreshStatus,
    }),
    [ready, panelAuthRequired, token, email, setSession, setPendingOtp, logout, refreshStatus],
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
