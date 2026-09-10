import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import {
  getAdminAuthMe,
  getAdminAuthSession,
  getAdminAuthStatus,
  postAdminLogout,
  postAdminRefreshSession,
} from '../lib/api'
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
import { useToast } from './ToastContext.jsx'

const AdminAuthContext = createContext(null)

/** Persist last panelAuthRequired so trusted installs skip the Inapakia gate on reopen. */
const PANEL_AUTH_HINT_KEY = 'osmani_admin_panel_auth_required_v1'

function readPanelAuthHint() {
  if (typeof localStorage === 'undefined') return true
  try {
    const v = localStorage.getItem(PANEL_AUTH_HINT_KEY)
    if (v === null) return true
    return v === 'true'
  } catch {
    return true
  }
}

function writePanelAuthHint(required) {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(PANEL_AUTH_HINT_KEY, required ? 'true' : 'false')
  } catch {
    /* ignore */
  }
}

export function AdminAuthProvider({ children }) {
  const { showToast } = useToast()
  // Keep last-known panelAuth hint; reconcile from /admin/auth/status in the background.
  const [panelAuthRequired, setPanelAuthRequired] = useState(() => readPanelAuthHint())
  const [ready, setReady] = useState(true)
  const [token, setTokenState] = useState(() => getAdminSessionToken())
  const [email, setEmail] = useState(() => getAdminSessionEmail())
  const [sessionChecked, setSessionChecked] = useState(() => !readPanelAuthHint())
  const [authBlocked, setAuthBlocked] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const d = await getAdminAuthStatus()
      const required = d?.panelAuthRequired === true
      setPanelAuthRequired(required)
      writePanelAuthHint(required)
      if (!required) setSessionChecked(true)
    } catch {
      // Fail closed: keep login required if status probe fails.
      setPanelAuthRequired(true)
      writePanelAuthHint(true)
      setSessionChecked(true)
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
    setAuthBlocked(false)
    window.dispatchEvent(new Event('osmani-admin-auth'))
  }, [])

  const setPendingOtp = useCallback((pendingToken, em) => {
    if (typeof sessionStorage === 'undefined') return
    if (pendingToken) sessionStorage.setItem(PENDING_OTP_KEY, pendingToken)
    else sessionStorage.removeItem(PENDING_OTP_KEY)
    if (em) sessionStorage.setItem(PENDING_EMAIL_KEY, em)
    else sessionStorage.removeItem(PENDING_EMAIL_KEY)
  }, [])

  const clearLocalAuthState = useCallback(() => {
    clearAdminSession()
    setTokenState(null)
    setEmail(null)
    setSessionChecked(true)
    window.dispatchEvent(new Event('osmani-admin-auth'))
  }, [])

  const logout = useCallback(async () => {
    try {
      await postAdminLogout()
    } catch {
      /* cookie clear may fail offline — still wipe local session */
    }
    clearLocalAuthState()
  }, [clearLocalAuthState])

  useEffect(() => {
    const onBlocked = () => {
      setAuthBlocked(true)
      showToast('error', 'Kifaa hiki kimezuiwa — umetolewa nje')
      void logout()
    }
    window.addEventListener('osmani-admin-auth-blocked', onBlocked)
    return () => window.removeEventListener('osmani-admin-auth-blocked', onBlocked)
  }, [logout, showToast])

  // Restore cookie/Bearer session when panel auth is required.
  useEffect(() => {
    let cancelled = false
    if (!ready || !panelAuthRequired) return undefined

    async function restoreSession() {
      try {
        const s = await getAdminAuthSession()
        if (cancelled) return
        const authenticated =
          s?.authenticated === true ||
          (s?.ok === true && (s?.token || s?.email))
        if (authenticated) {
          const nextToken = s.token || getAdminSessionToken()
          const nextEmail = s.email || getAdminSessionEmail() || ''
          if (nextToken) setSession(nextToken, nextEmail)
        }
      } catch {
        /* keep local token; validateSession / me will reconcile */
      }
    }

    void restoreSession()
    return () => {
      cancelled = true
    }
  }, [ready, panelAuthRequired, setSession])

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
          await logout()
          return
        }
        const nextEmail = String(me.email ?? '').trim()
        if (nextEmail) {
          setAdminSessionEmail(nextEmail)
          setEmail(nextEmail)
        }
      } catch {
        if (!cancelled) await logout()
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
      authBlocked,
      setSession,
      setPendingOtp,
      logout,
      refreshStatus,
    }),
    [
      ready,
      sessionChecked,
      panelAuthRequired,
      token,
      email,
      authBlocked,
      setSession,
      setPendingOtp,
      logout,
      refreshStatus,
    ],
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
