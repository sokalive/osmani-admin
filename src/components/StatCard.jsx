/** Reusable dashboard stat card — use with `className="dashboard-card"` for fixed layout */

function StatCard({
  icon: Icon,
  title,
  value,
  gradientClass,
  badgeText,
  className = '',
  dense = false,
}) {
  return (
    <article
      className={`relative box-border border border-slate-600/35 text-white shadow-[0_12px_28px_rgba(0,0,0,0.22)] ${gradientClass} ${className}`}
    >
      <div className="pointer-events-none absolute right-0 top-0 h-20 w-20 translate-x-1/4 -translate-y-1/4 rounded-full bg-white/12 blur-2xl" />

      <div className="card-total relative z-10 min-w-0 w-full">
        <div className="flex shrink-0 items-start justify-between gap-2">
          <div className="rounded-xl bg-black/20 p-2.5">
            <Icon className="h-5 w-5 text-white" aria-hidden />
          </div>
          {badgeText ? (
            <span className="live-badge shrink-0 rounded-full border border-red-300/70 bg-red-500/90 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-[0.2em] text-white">
              {badgeText}
            </span>
          ) : null}
        </div>

        <div className="min-w-0 space-y-1">
          <p
            className={`card-total-number ${dense ? '!text-xl !leading-tight' : ''} truncate tabular-nums`}
          >
            {value}
          </p>
          <p className={`card-total-title ${dense ? '' : 'line-clamp-2'}`}>{title}</p>
        </div>
      </div>
    </article>
  )
}

export default StatCard
