import { useEffect, useRef, useState } from 'react'

/**
 * Modal to collect ADMIN_SECURITY_PIN (server-verified separately).
 */
export default function SecurityPinModal({
  open,
  title = 'Ingiza Security PIN',
  submitLabel = 'Endelea',
  errorText,
  busy,
  onClose,
  onSubmit,
}) {
  const inputRef = useRef(null)
  const [pin, setPin] = useState('')

  useEffect(() => {
    if (!open) {
      setPin('')
      return
    }
    const t = window.setTimeout(() => inputRef.current?.focus(), 80)
    return () => window.clearTimeout(t)
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[140] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/80 backdrop-blur-[2px]"
        aria-label="Funga"
        onClick={() => !busy && onClose?.()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-pin-title"
        className="relative w-full max-w-sm rounded-2xl border border-slate-600/60 bg-[#0f172a] p-6 shadow-2xl ring-1 ring-amber-500/15"
      >
        <h2 id="security-pin-title" className="text-lg font-bold text-white">
          {title}
        </h2>
        <p className="mt-1 text-sm text-slate-400">
          PIN inathibitiwa kwenye server; hauhifadhiwi kwenye kumbukumbu ya kudumu.
        </p>
        <form
          className="mt-4 space-y-3"
          onSubmit={(e) => {
            e.preventDefault()
            if (!pin.trim() || busy) return
            void onSubmit?.(pin.trim())
          }}
        >
          <input
            ref={inputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
            className="w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 font-mono text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25"
            placeholder="••••"
          />
          {errorText ? <p className="text-sm font-medium text-rose-300">{errorText}</p> : null}
          <div className="flex justify-end gap-2 pt-1">
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
              disabled={busy || !pin.trim()}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-4 py-2 text-sm font-bold text-slate-950 shadow-[0_6px_20px_rgba(251,191,36,0.25)] disabled:opacity-40"
            >
              {busy ? 'Inahakiki…' : submitLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
