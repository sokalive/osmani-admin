import { AlertCircle, CheckCircle2, X } from 'lucide-react'

/**
 * @param {{ type: 'success' | 'error'; message: string; onDismiss: () => void }} props
 */
function FlashMessage({ type, message, onDismiss }) {
  if (!message) return null
  const isOk = type === 'success'
  return (
    <div
      role="alert"
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm shadow-lg ${
        isOk
          ? 'border-emerald-500/40 bg-emerald-950/60 text-emerald-100'
          : 'border-red-500/40 bg-red-950/60 text-red-100'
      }`}
    >
      {isOk ? (
        <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
      ) : (
        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-red-400" />
      )}
      <p className="min-w-0 flex-1 leading-relaxed">{message}</p>
      <button
        type="button"
        onClick={onDismiss}
        className="shrink-0 rounded-lg p-1 text-current opacity-70 transition-opacity hover:opacity-100"
        aria-label="Dismiss"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

export default FlashMessage
