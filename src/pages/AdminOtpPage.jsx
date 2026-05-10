import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Shield } from 'lucide-react'
import { getPendingOtpEmail, getPendingOtpToken, useAdminAuth } from '../context/AdminAuthContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import { getAdminDeviceFingerprintRaw } from '../lib/adminDeviceFingerprint'
import { postAdminResendOtp, postAdminVerifyOtp } from '../lib/api'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-3 text-center font-mono text-2xl tracking-[0.5em] text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

export default function AdminOtpPage() {
  const navigate = useNavigate()
  const { showToast } = useToast()
  const { ready, panelAuthRequired, token, setSession } = useAdminAuth()
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)

  const pendingToken = getPendingOtpToken()
  const pendingEmail = getPendingOtpEmail()

  useEffect(() => {
    if (!ready) return
    if (!panelAuthRequired) {
      navigate('/', { replace: true })
      return
    }
    if (token) navigate('/', { replace: true })
    else if (!pendingToken) navigate('/login', { replace: true })
  }, [ready, panelAuthRequired, token, pendingToken, navigate])

  async function handleVerify(e) {
    e.preventDefault()
    const c = code.replace(/\D/g, '').slice(0, 6)
    if (c.length !== 6) {
      showToast('error', 'Ingiza nambari 6')
      return
    }
    setBusy(true)
    try {
      const out = await postAdminVerifyOtp({
        pending_token: pendingToken,
        code: c,
        device_fingerprint: getAdminDeviceFingerprintRaw(),
        device_name: typeof navigator !== 'undefined' ? navigator.platform || 'Web' : 'Web',
        browser: typeof navigator !== 'undefined' ? navigator.userAgent?.slice(0, 400) : '',
      })
      if (!out?.ok || !out.token) {
        showToast('error', out?.error || 'Nambari si sahihi')
        return
      }
      setSession(out.token, out.email || pendingEmail || '')
      showToast('success', 'Kifaa kimethibitishwa')
      navigate('/', { replace: true })
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana')
    } finally {
      setBusy(false)
    }
  }

  async function handleResend() {
    setBusy(true)
    try {
      await postAdminResendOtp({
        pending_token: pendingToken,
        device_fingerprint: getAdminDeviceFingerprintRaw(),
      })
      showToast('success', 'OTP imetumwa tena')
    } catch (err) {
      showToast('error', err?.message || 'Imeshindikana kutuma tena')
    } finally {
      setBusy(false)
    }
  }

  if (!ready || !panelAuthRequired || !pendingToken) return null

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[#0B0F1A] px-4">
      <div className="mb-6 flex flex-col items-center gap-2 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-2xl border border-amber-500/35 bg-amber-500/10">
          <Shield className="h-7 w-7 text-amber-300" aria-hidden />
        </div>
        <h1 className="text-xl font-bold text-white">Thibitisha kifaa</h1>
        <p className="max-w-sm text-sm text-slate-400">
          Tumekutumia nambari ya tarakimu 6 kwa <span className="text-slate-200">{pendingEmail}</span>. Nambari
          inaisha dakika 5.
        </p>
      </div>

      <form
        onSubmit={handleVerify}
        className="w-full max-w-sm space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/50 p-6 ring-1 ring-white/[0.04]"
      >
        <input
          inputMode="numeric"
          autoComplete="one-time-code"
          maxLength={6}
          placeholder="••••••"
          className={inputClass()}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
        <button
          type="submit"
          disabled={busy}
          className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold text-slate-950 disabled:opacity-60"
        >
          {busy ? 'Inathibitisha…' : 'Thibitisha OTP'}
        </button>
        <button
          type="button"
          onClick={() => void handleResend()}
          disabled={busy}
          className="w-full rounded-xl border border-slate-600 py-2.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
        >
          Tuma OTP tena
        </button>
        <button
          type="button"
          onClick={() => navigate('/login', { replace: true })}
          className="w-full text-center text-xs text-slate-500 hover:text-slate-400"
        >
          Rudi nyuma
        </button>
      </form>
    </div>
  )
}
