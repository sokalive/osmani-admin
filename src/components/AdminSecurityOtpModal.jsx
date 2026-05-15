import { useEffect, useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'

function secondsUntil(iso) {
  if (!iso) return 0
  const t = new Date(iso).getTime()
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.ceil((t - Date.now()) / 1000))
}

/**
 * Email OTP step after Admin Security PIN (server challenge).
 */
export default function AdminSecurityOtpModal({
  open,
  maskedEmail,
  resendAvailableAt,
  errorText,
  busy,
  onClose,
  onSubmit,
  onResend,
}) {
  const inputRef = useRef(null)
  const [otp, setOtp] = useState('')
  const [resendSec, setResendSec] = useState(0)

  useEffect(() => {
    if (!open) {
      setOtp('')
      return
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 80)
    return () => window.clearTimeout(t)
  }, [open])

  useEffect(() => {
    if (!open) return undefined
    const tick = () => setResendSec(secondsUntil(resendAvailableAt))
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [open, resendAvailableAt])

  if (!open) return null

  const canResend = resendSec <= 0 && !busy

  return (
    <div className="fixed inset-0 z-[145] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/80 backdrop-blur-[2px]"
        aria-label="Funga"
        onClick={() => !busy && onClose?.()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="admin-security-otp-title"
        className="relative w-full max-w-sm rounded-2xl border border-emerald-500/25 bg-[#0f172a] p-6 shadow-2xl ring-1 ring-emerald-500/15"
      >
        <h2 id="admin-security-otp-title" className="text-lg font-bold text-white">
          Thibitisha kwa OTP
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          Nambari ya tarakimu 6 imetumwa kwa{' '}
          <span className="font-medium text-emerald-200/90">{maskedEmail || 'admin alert email'}</span>.
          Inaisha baada ya dakika 5.
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (otp.length !== 6 || busy) return
            void onSubmit?.(otp)
          }}
        >
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-center font-mono text-lg tracking-[0.4em] text-slate-100 placeholder:text-slate-500 focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/25"
            placeholder="000000"
          />
          {errorText ? <p className="text-sm font-medium text-rose-300">{errorText}</p> : null}
          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              type="button"
              disabled={!canResend}
              onClick={() => canResend && void onResend?.()}
              className="text-xs font-semibold text-cyan-300 hover:text-cyan-200 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {canResend ? 'Tuma OTP tena' : `Tuma tena (${resendSec}s)`}
            </button>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => onClose?.()}
              className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              Ghairi
            </button>
            <button
              type="submit"
              disabled={busy || otp.length !== 6}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-500 px-4 py-2 text-sm font-bold text-slate-950 disabled:opacity-40"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {busy ? 'Inahakiki…' : 'Thibitisha'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
