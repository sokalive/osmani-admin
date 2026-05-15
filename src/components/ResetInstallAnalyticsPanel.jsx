import { useCallback, useEffect, useState } from 'react'
import { AlertTriangle, Loader2, ShieldAlert } from 'lucide-react'
import { useToast } from '../context/ToastContext.jsx'
import {
  getAnalyticsResetInstallsStatus,
  postAnalyticsResetExecute,
  postAnalyticsResetResendOtp,
  postAnalyticsResetSendOtp,
  postAnalyticsResetVerifyPassword,
} from '../lib/api'

const STEPS = { idle: 'idle', password: 'password', otp: 'otp', confirm: 'confirm', done: 'done' }

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-rose-500/50 focus:outline-none focus:ring-2 focus:ring-rose-500/20'
}

export default function ResetInstallAnalyticsPanel({ onResetComplete }) {
  const { showToast } = useToast()
  const [step, setStep] = useState(STEPS.idle)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(null)
  const [challengeToken, setChallengeToken] = useState('')
  const [maskedEmail, setMaskedEmail] = useState('')
  const [password, setPassword] = useState('')
  const [otp, setOtp] = useState('')
  const [confirmText, setConfirmText] = useState('')
  const [error, setError] = useState('')

  const refreshStatus = useCallback(async () => {
    try {
      const s = await getAnalyticsResetInstallsStatus()
      setStatus(s)
    } catch {
      setStatus(null)
    }
  }, [])

  useEffect(() => {
    void refreshStatus()
  }, [refreshStatus])

  function closeFlow() {
    if (busy) return
    setStep(STEPS.idle)
    setPassword('')
    setOtp('')
    setConfirmText('')
    setChallengeToken('')
    setError('')
  }

  async function submitPassword(e) {
    e.preventDefault()
    setBusy(true)
    setError('')
    try {
      const out = await postAnalyticsResetVerifyPassword({ password })
      setChallengeToken(out.challengeToken)
      setStep(STEPS.otp)
      setPassword('')
      const sent = await postAnalyticsResetSendOtp({ challengeToken: out.challengeToken })
      setMaskedEmail(sent.maskedEmail || '')
      showToast('success', 'OTP sent to admin alert email')
    } catch (err) {
      setError(err?.message || 'Password verification failed')
    } finally {
      setBusy(false)
    }
  }

  async function resendOtp() {
    if (!challengeToken) return
    setBusy(true)
    setError('')
    try {
      const sent = await postAnalyticsResetResendOtp({ challengeToken })
      setMaskedEmail(sent.maskedEmail || maskedEmail)
      showToast('success', 'OTP resent')
    } catch (err) {
      setError(err?.message || 'Could not resend OTP')
    } finally {
      setBusy(false)
    }
  }

  function proceedToConfirm(e) {
    e.preventDefault()
    if (otp.trim().length !== 6) {
      setError('Enter the 6-digit OTP')
      return
    }
    setError('')
    setStep(STEPS.confirm)
  }

  async function executeReset(e) {
    e.preventDefault()
    if (confirmText.trim().toUpperCase() !== 'RESET') {
      setError('Type RESET to confirm')
      return
    }
    setBusy(true)
    setError('')
    try {
      const out = await postAnalyticsResetExecute({ challengeToken, otp: otp.trim() })
      showToast(
        'success',
        `Cleared ${out.installsDeleted ?? 0} installs and ${out.sessionsDeleted ?? 0} sessions`,
      )
      setStep(STEPS.done)
      await refreshStatus()
      onResetComplete?.()
    } catch (err) {
      setError(err?.message || 'Reset failed')
    } finally {
      setBusy(false)
    }
  }

  const cooldownActive = status?.cooldownActive === true

  return (
    <section className="rounded-2xl border border-rose-500/30 bg-gradient-to-br from-rose-950/40 via-slate-950/90 to-slate-950/90 p-6 ring-1 ring-rose-500/20">
      
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-rose-300">
              <ShieldAlert className="h-4 w-4" />
              Danger zone
            </p>
            <h2 className="mt-2 text-lg font-semibold text-white">Reset install analytics</h2>
            <p className="mt-2 max-w-xl text-sm text-slate-400">
              Are you sure you want to reset analytics/install counters? This clears install records
              and live session counters only — not subscriptions, payments, or user accounts.
            </p>
            {cooldownActive ? (
              <p className="mt-3 inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs text-amber-200">
                <AlertTriangle className="h-3.5 w-3.5" />
                Cooldown active — try again in about {status.cooldownMinutesRemaining} min
              </p>
            ) : null}
            {status?.lastResetAt ? (
              <p className="mt-2 text-xs text-slate-500">
                Last reset: {new Date(status.lastResetAt).toLocaleString('en-GB')}
              </p>
            ) : null}
          </div>
          <button
            type="button"
            disabled={cooldownActive || step !== STEPS.idle}
            onClick={() => {
              setError('')
              setStep(STEPS.password)
            }}
            className="shrink-0 rounded-xl border border-rose-500/50 bg-rose-500/15 px-4 py-2.5 text-sm font-semibold text-rose-100 hover:bg-rose-500/25 disabled:cursor-not-allowed disabled:opacity-40"
          >
            Reset Install Analytics
          </button>
        </div>
      

      {step !== STEPS.idle ? (
        <div className="fixed inset-0 z-[130] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            aria-label="Close"
            onClick={closeFlow}
          />
          <div
            className="relative w-full max-w-md rounded-2xl border border-rose-500/30 bg-[#0b1220] p-6 shadow-2xl ring-1 ring-rose-500/15"
            role="dialog"
            aria-modal="true"
          >
            {step === STEPS.password ? (
              <form onSubmit={submitPassword} className="space-y-4">
                <h3 className="text-lg font-bold text-white">Admin security password</h3>
                <p className="text-sm text-slate-400">
                  Enter the security password to continue. An OTP will be emailed to the admin alert
                  address.
                </p>
                <input
                  type="password"
                  autoComplete="off"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className={inputClass()}
                  placeholder="Security password"
                />
                {error ? <p className="text-sm text-rose-300">{error}</p> : null}
                
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={closeFlow}
                      className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300"
                    >
                      Cancel
                    </button>
                    <button
                      type="submit"
                      disabled={busy || !password.trim()}
                      className="inline-flex items-center gap-2 rounded-xl bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-100 ring-1 ring-rose-500/40 disabled:opacity-50"
                    >
                      {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                      Continue
                    </button>
                  </div>
              </form>
            ) : null}

            {step === STEPS.otp ? (
              <form onSubmit={proceedToConfirm} className="space-y-4">
                <h3 className="text-lg font-bold text-white">Email OTP</h3>
                <p className="text-sm text-slate-400">
                  Enter the 6-digit code sent to {maskedEmail || 'admin alert email'}. Expires in 5
                  minutes.
                </p>
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  value={otp}
                  onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  className={`${inputClass()} font-mono tracking-[0.4em]`}
                  placeholder="000000"
                />
                {error ? <p className="text-sm text-rose-300">{error}</p> : null}
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void resendOtp()}
                  className="text-xs font-medium text-cyan-300 hover:text-cyan-200 disabled:opacity-50"
                >
                  Resend OTP
                </button>
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeFlow}
                    className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={busy || otp.length !== 6}
                    className="rounded-xl bg-rose-500/20 px-4 py-2 text-sm font-semibold text-rose-100 ring-1 ring-rose-500/40 disabled:opacity-50"
                  >
                    Next
                  </button>
                </div>
              </form>
            ) : null}

            {step === STEPS.confirm ? (
              <form onSubmit={executeReset} className="space-y-4">
                <h3 className="text-lg font-bold text-white">Confirm reset</h3>
                <p className="text-sm text-slate-400">
                  Are you sure you want to reset analytics/install counters? This cannot be undone.
                </p>
                <p className="text-xs text-slate-500">
                  Type <strong className="text-rose-300">RESET</strong> to confirm.
                </p>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  className={inputClass()}
                  placeholder="RESET"
                />
                {error ? <p className="text-sm text-rose-300">{error}</p> : null}
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setStep(STEPS.otp)}
                    className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300"
                  >
                    Back
                  </button>
                  <button
                    type="submit"
                    disabled={busy}
                    className="inline-flex items-center gap-2 rounded-xl bg-red-600/80 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600 disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                    Reset now
                  </button>
                </div>
              </form>
            ) : null}

            {step === STEPS.done ? (
              <div className="space-y-4 text-center">
                <p className="text-lg font-semibold text-emerald-300">
                  Install analytics reset complete
                </p>
                <p className="text-sm text-slate-400">Charts will refresh from empty counters.</p>
                <button
                  type="button"
                  onClick={closeFlow}
                  className="rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white"
                >
                  Close
                </button>
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
  )
}
