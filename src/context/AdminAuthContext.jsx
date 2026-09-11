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
  clearAdminDeviceCredential,
  clearAdminSession,
  clearAdminSessionTokenOnly,
  getAdminDeviceCredential,
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

function isHardAuthFailure(err) {
  const code = String(err?.code || err?.body?.code || '').toUpperCase()
  return (
    code === 'DEVICE_BLOCKED' ||
    code === 'DEVICE_REVOKED' ||
    code === 'TRUST_EXPIRED' ||
    code === 'FORCE_OTP'
  )
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

  const clearLocalAuthState = useCallback(({ keepDeviceCredential = false } = {}) => {
    if (keepDeviceCredential) clearAdminSessionTokenOnly()
    else clearAdminSession()
    setTokenState(null)
    setEmail(null)
    setSessionChecked(true)
    window.dispatchEvent(new Event('osmani-admin-auth'))
  }, [])

  const logout = useCallback(async () => {
    try {
      // Session logout only — trusted-device credential remains for 14-day restore.
      await postAdminLogout()
    } catch {
      /* cookie clear may fail offline — still wipe local session */
    }
    clearLocalAuthState({ keepDeviceCredential: true })
  }, [clearLocalAuthState])

  useEffect(() => {
    const onBlocked = () => {
      setAuthBlocked(true)
      showToast('error', 'Kifaa hiki kimezuiwa — umetolewa nje')
      clearAdminSession()
      clearLocalAuthState({ keepDeviceCredential: false })
    }
    window.addEventListener('osmani-admin-auth-blocked', onBlocked)
    return () => window.removeEventListener('osmani-admin-auth-blocked', onBlocked)
  }, [clearLocalAuthState, showToast])

  // Single boot path: prefer GET /session (device credential restore) BEFORE wiping anything.
  useEffect(() => {
    let cancelled = false
    if (!ready) return undefined
    if (!panelAuthRequired) {
      setSessionChecked(true)
      return undefined
    }

    setSessionChecked(false)

    async function bootSession() {
      try {
        const s = await getAdminAuthSession()
        if (cancelled) return

        if (s?.code === 'DEVICE_BLOCKED') {
          clearLocalAuthState({ keepDeviceCredential: false })
          setAuthBlocked(true)
          return
        }
        if (
          s?.code === 'DEVICE_REVOKED' ||
          s?.code === 'TRUST_EXPIRED' ||
          s?.code === 'FORCE_OTP'
        ) {
          // Trust invalid — drop credential so login/OTP can re-enroll.
          clearAdminDeviceCredential()
          clearLocalAuthState({ keepDeviceCredential: false })
          return
        }

        const authenticated =
          s?.authenticated === true || (s?.ok === true && (s?.token || s?.email))
        if (authenticated) {
          const nextToken = s.token || getAdminSessionToken()
          const nextEmail = s.email || getAdminSessionEmail() || ''
          if (nextToken) setSession(nextToken, nextEmail)

          // Soft validate; never clear device credential on transient /me failure.
          try {
            if (nextToken && adminJwtNeedsRefresh(nextToken)) {
              const refreshed = await postAdminRefreshSession()
              if (refreshed?.ok === true && refreshed.token) {
                setSession(refreshed.token, refreshed.email || nextEmail)
              }
            }
            const me = await getAdminAuthMe()
            if (cancelled) return
            if (me?.ok === true) {
              const em = String(me.email ?? '').trim()
              if (em) {
                setAdminSessionEmail(em)
                setEmail(em)
              }
            }
          } catch (err) {
            if (cancelled) return
            if (isHardAuthFailure(err)) {
              clearAdminDeviceCredential()
              clearLocalAuthState({ keepDeviceCredential: false })
              if (String(err?.code || '') === 'DEVICE_BLOCKED') setAuthBlocked(true)
            }
            // Soft failure: keep restored session / device credential.
          }
          return
        }

        // No restore — drop stale JWT only; keep device credential for next attempt
        // unless we have nothing useful to restore with.
        if (getAdminSessionToken() && !getAdminDeviceCredential()) {
          clearLocalAuthState({ keepDeviceCredential: true })
        } else if (getAdminSessionToken() && getAdminDeviceCredential()) {
          // Stale JWT with still-present device cred: clear JWT; next boot restores via /session.
          clearLocalAuthState({ keepDeviceCredential: true })
        }
      } catch (err) {
        if (cancelled) return
        if (isHardAuthFailure(err)) {
          clearAdminDeviceCredential()
          clearLocalAuthState({ keepDeviceCredential: false })
          if (String(err?.code || '') === 'DEVICE_BLOCKED') setAuthBlocked(true)
        } else {
          // Network / transient — do not wipe trusted-device credential.
          clearLocalAuthState({ keepDeviceCredential: true })
        }
      } finally {
        if (!cancelled) setSessionChecked(true)
      }
    }

    void bootSession()
    return () => {
      cancelled = true
    }
  }, [ready, panelAuthRequired, setSession, clearLocalAuthState])

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
