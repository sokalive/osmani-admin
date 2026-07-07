import { Copy } from 'lucide-react'
import { useToast } from '../context/ToastContext.jsx'

/** Full canonical device_id with copy — for actionable Admin tables. */
export default function AdminDeviceIdCell({ deviceId, className = '' }) {
  const id = String(deviceId ?? '').trim()
  const { showToast } = useToast()

  if (!id) {
    return <span className="text-slate-500">—</span>
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(id)
      showToast('success', 'Device ID copied')
    } catch {
      showToast('error', 'Copy failed')
    }
  }

  return (
    <div className={`flex min-w-0 items-start gap-1.5 ${className}`}>
      <span className="min-w-0 break-all font-mono text-[11px] leading-snug text-slate-300" title={id}>
        {id}
      </span>
      <button
        type="button"
        onClick={copy}
        className="shrink-0 rounded p-0.5 text-slate-500 hover:text-amber-300"
        aria-label="Copy device ID"
        title="Copy device ID"
      >
        <Copy className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
