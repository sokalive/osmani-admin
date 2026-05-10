import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shield } from 'lucide-react'
import { useAdminAuth } from '../context/AdminAuthContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { getAdminDeviceFingerprintRaw } from '../lib/adminDeviceFingerprint'
import { postAdminEmergencyPin, postAdminLogin } from '../lib/api'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

export default function AdminLoginPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { ready, panelAuthRequired, token, setSession, setPendingOtp } = useAdminAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [emergencyOpen, setEmergencyOpen] = useState(false)
  const [emergencyPin, setEmergencyPin] = useState('')
  const tripleTapTimerRef = useRef(null)
  const tripleTapCountRef = useRef(0)

  useEffect(() => {
    if (!ready) return
    if (!panelAuthRequired) {
      navigate('/', { replace: true })
      return
    }
    if (token) navigate('/', { replace: true })
  }, [ready, panelAuthRequired, token, navigate])

  async function handleSubmit(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const device_fingerprint = getAdminDeviceFingerprintRaw()
      const out = await postAdminLogin({
        email: email.trim(),
        password,
        device_fingerprint,
        device_name: typeof navigator !== 'undefined' ? navigator.platform || 'Web' : 'Web',
        browser: typeof navigator !== 'undefined' ? navigator.userAgent?.slice(0, 400) : '',
      })
      if (!out?.ok) {
        showToast('error', out?.error || 'Imeshindikana')
        return
      }
      if (out.step === 'authenticated' && out.token) {
        setSession(out.token, out.email || email.trim())
        showToast('success', 'Karibu')
        navigate('/', { replace: true })
        return
      }
      if (out.step === 'otp_required' && out.pendingToken) {
        setPendingOtp(out.pendingToken, out.email || email.trim())
        showToast('success', out.message || 'Angalia barua pepe kwa OTP')
        navigate('/login/otp', { replace: true })
        return
      }
      showToast('error', 'Mwitiko usiotarajiwa')
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setBusy(false)
    }
  }

  async function handleEmergency(e) {
    e.preventDefault()
    setBusy(true)
    try {
      const device_fingerprint = getAdminDeviceFingerprintRaw()
      const out = await postAdminEmergencyPin({
        email: email.trim(),
        password,
        pin: emergencyPin.trim(),
        device_fingerprint,
      })
      if (!out?.ok || !out.token) {
        showToast('error', out?.error || 'Imeshindikana')
        return
      }
      setSession(out.token, out.email || email.trim())
      showToast('success', 'Ufikivu wa dharura — tumia kwa uangalifu')
      setEmergencyOpen(false)
      navigate('/', { replace: true })
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setBusy(false)
    }
  }

  function headerTap() {
    tripleTapCountRef.current += 1
    window.clearTimeout(tripleTapTimerRef.current)
    tripleTapTimerRef.current = window.setTimeout(() => {
      tripleTapCountRef.current = 0
    }, 600)
    if (tripleTapCountRef.current >= 3) {
      tripleTapCountRef.current = 0
      setEmergencyOpen(true)
    }
  }

  if (!ready || !panelAuthRequired) return null

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0B0F1A] px-4 py-12">
      <button
        type="button"
        onClick={headerTap}
        className="mb-6 flex flex-col items-center gap-2 rounded-2xl border border-transparent bg-transparent p-2 text-center outline-none"
        aria-hidden
      >
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/35 bg-amber-500/10">
          <Shield className="h-7 w-7 text-amber-300" aria-hidden />
        </div>
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.25em] text-amber-400/90">Osmani TV</p>
          <h1 className="mt-1 text-2xl font-bold text-white">Ingia Admin</h1>
        </div>
      </button>

      <form
        onSubmit={handleSubmit}
        className="w-full max-w-md space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/50 p-6 ring-1 ring-white/[0.04]"
      >
        <div>
          <label htmlFor="adm-email" className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
            Barua pepe
          </label>
          <input
            id="adm-email"
            type="email"
            autoComplete="username"
            className={inputClass()}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </div>
        <div>
          <label htmlFor="adm-pass" className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
            Nenosiri
          </label>
          <input
            id="adm-pass"
            type="password"
            autoComplete="current-password"
            className={inputClass()}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold text-slate-950 shadow-lg disabled:opacity-60"
        >
          {busy ? 'Inaendelea…' : 'Ingia'}
        </button>
      </form>

      {emergencyOpen ? (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-600 bg-[#0f172a] p-6 shadow-2xl">
            <h2 className="text-lg font-semibold text-white">Ufikivu wa dharura</h2>
            <p className="mt-2 text-sm text-slate-400">
              Tumia PIN ya ops ya mfumo (mf. manual subscription). Hatua hii inarekodiwa.
            </p>
            <form onSubmit={handleEmergency} className="mt-4 space-y-3">
              <input
                type="password"
                placeholder="PIN ya dharura"
                className={inputClass()}
                value={emergencyPin}
                onChange={(e) => setEmergencyPin(e.target.value)}
                autoComplete="off"
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setEmergencyOpen(false)}
                  className="flex-1 rounded-xl border border-slate-600 py-2 text-sm text-slate-300"
                >
                  Funga
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="flex-1 rounded-xl bg-amber-500 py-2 text-sm font-bold text-slate-950 disabled:opacity-50"
                >
                  Thibitisha
                </button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  )
}
