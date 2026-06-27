import { Ban, Circle, Phone, Wrench } from 'lucide-react'

const basePill =
  'inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-full px-5 py-2.5 text-[11px] font-bold uppercase tracking-[0.14em] transition-all duration-300 sm:text-xs sm:tracking-[0.12em]'

const offBase =
  'border border-white/10 bg-[#1e293b] text-slate-400 shadow-none hover:border-white/[0.14] hover:bg-[#243047] hover:text-slate-300'

const variants = {
  free: {
    onGradient:
      'bg-gradient-to-r from-[#16a34a] to-[#22c55e] text-white shadow-[0_0_28px_rgba(34,197,94,0.45),0_8px_24px_rgba(22,163,74,0.35)] ring-1 ring-emerald-300/35 hover:brightness-[1.03]',
    onLabel: (
      <>
        <span
          className="flex h-2 w-2 shrink-0 rounded-full bg-emerald-100 shadow-[0_0_10px_2px_rgba(134,239,172,0.95)]"
          aria-hidden
        />
        <span>FREE MODE ACTIVE</span>
      </>
    ),
    offIcon: <Circle className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2} aria-hidden />,
    offLabel: 'FREE MODE',
  },
  emergency: {
    onGradient:
      'bg-gradient-to-r from-[#ef4444] to-[#f97316] text-white shadow-[0_0_28px_rgba(239,68,68,0.45),0_8px_24px_rgba(249,115,22,0.3)] ring-1 ring-orange-300/35 hover:brightness-[1.03]',
    onLabel: (
      <>
        <span className="shrink-0 text-base leading-none" aria-hidden>
          🚫
        </span>
        <span>EMERGENCY MODE ON</span>
      </>
    ),
    offIcon: <Ban className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2} aria-hidden />,
    offLabel: 'EMERGENCY MODE',
  },
  maintenance: {
    onGradient:
      'bg-gradient-to-r from-[#eab308] to-[#f59e0b] text-slate-950 shadow-[0_0_28px_rgba(234,179,8,0.4),0_8px_24px_rgba(245,158,11,0.35)] ring-1 ring-amber-200/50 hover:brightness-[1.03]',
    onLabel: (
      <>
        <span className="shrink-0 text-base leading-none" aria-hidden>
          🛠
        </span>
        <span>MAINTENANCE MODE ON</span>
      </>
    ),
    offIcon: <Wrench className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2} aria-hidden />,
    offLabel: 'MAINTENANCE MODE',
  },
  phone: {
    onGradient:
      'bg-gradient-to-r from-[#38bdf8] to-[#0ea5e9] text-white shadow-[0_0_28px_rgba(56,189,248,0.4),0_8px_24px_rgba(14,165,233,0.35)] ring-1 ring-sky-200/50 hover:brightness-[1.03]',
    onLabel: (
      <>
        <Phone className="h-4 w-4 shrink-0" strokeWidth={2.2} aria-hidden />
        <span>PHONE GATE ON</span>
      </>
    ),
    offIcon: <Phone className="h-4 w-4 shrink-0 text-slate-500" strokeWidth={2} aria-hidden />,
    offLabel: 'PHONE GATE',
  },
}

/**
 * Streaming dashboard mode control — OFF: slate pill + muted icon; ON: solid gradient pill + glow.
 */
function ModeControlButton({ variant, active, onToggle, ariaLabel, disabled = false }) {
  const v = variants[variant]

  return (
    <button
      type="button"
      role="switch"
      aria-checked={active}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onToggle(!active)}
      className={`${basePill} ${active ? v.onGradient : offBase} ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      {active ? (
        <span className="inline-flex items-center gap-2">{v.onLabel}</span>
      ) : (
        <>
          {v.offIcon}
          <span>{v.offLabel}</span>
        </>
      )}
    </button>
  )
}

export default ModeControlButton
