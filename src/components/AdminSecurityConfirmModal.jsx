import { useEffect, useState } from 'react'
import { AlertTriangle } from 'lucide-react'

/**
 * Typed confirmation before destructive Admin Security actions.
 */
export default function AdminSecurityConfirmModal({
  open,
  title,
  message,
  confirmPhrase = 'DELETE',
  requireTyped = false,
  busy,
  onClose,
  onConfirm,
}) {
  const [typed, setTyped] = useState('')

  useEffect(() => {
    if (!open) setTyped('')
  }, [open])

  if (!open) return null

  const canConfirm = !busy && (!requireTyped || typed.trim().toUpperCase() === confirmPhrase)

  return (
    <div className="fixed inset-0 z-[146] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/80 backdrop-blur-[2px]"
        aria-label="Funga"
        onClick={() => !busy && onClose?.()}
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-md rounded-2xl border border-rose-500/30 bg-[#0f172a] p-6 shadow-2xl ring-1 ring-rose-500/20"
      >
        <div className="flex items-start gap-3">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-rose-400" aria-hidden />
          <div>
            <h2 className="text-lg font-bold text-white">{title}</h2>
            <p className="mt-2 text-sm text-slate-400">{message}</p>
          </div>
        </div>
        {requireTyped ? (
          <div className="mt-4 space-y-2">
            <p className="text-xs text-slate-500">
              Andika <strong className="text-rose-300">{confirmPhrase}</strong> ili kuthibitisha.
            </p>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              className="w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-rose-500/50 focus:outline-none focus:ring-2 focus:ring-rose-500/20"
              placeholder={confirmPhrase}
              autoComplete="off"
            />
          </div>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onClose?.()}
            className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800 disabled:opacity-40"
          >
            Ghairi
          </button>
          <button
            type="button"
            disabled={!canConfirm}
            onClick={() => onConfirm?.()}
            className="rounded-xl bg-rose-600/90 px-4 py-2 text-sm font-bold text-white hover:bg-rose-500 disabled:opacity-40"
          >
            {busy ? 'Inaendelea…' : 'Thibitisha'}
          </button>
        </div>
      </div>
    </div>
  )
}
