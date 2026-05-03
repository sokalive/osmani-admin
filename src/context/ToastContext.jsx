import { createContext, useCallback, useContext, useMemo, useState } from 'react'

const ToastContext = createContext(null)

export function ToastProvider({ children }) {
  const [toast, setToast] = useState(null)

  const showToast = useCallback((type, message) => {
    if (!message) return
    setToast({ type, message, id: Date.now() })
    window.setTimeout(() => setToast((t) => (t?.message === message ? null : t)), 5000)
  }, [])

  const dismiss = useCallback(() => setToast(null), [])

  const value = useMemo(() => ({ showToast, dismiss }), [showToast, dismiss])

  return (
    <ToastContext.Provider value={value}>
      {children}
      {toast ? (
        <div
          role="status"
          className={`fixed bottom-6 right-6 z-[200] max-w-sm rounded-xl border px-4 py-3 text-sm font-medium shadow-2xl ${
            toast.type === 'error'
              ? 'border-red-500/50 bg-red-950/95 text-red-100'
              : 'border-emerald-500/45 bg-emerald-950/95 text-emerald-100'
          }`}
        >
          <div className="flex items-start gap-3">
            <p className="flex-1 leading-snug">{toast.message}</p>
            <button
              type="button"
              onClick={dismiss}
              className="shrink-0 rounded-lg px-2 py-0.5 text-xs uppercase text-slate-400 hover:text-white"
            >
              OK
            </button>
          </div>
        </div>
      ) : null}
    </ToastContext.Provider>
  )
}

export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) return { showToast: () => {}, dismiss: () => {} }
  return ctx
}
