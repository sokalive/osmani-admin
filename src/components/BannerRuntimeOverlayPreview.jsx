import { useMemo } from 'react'
import { motion } from 'framer-motion'
import { parseTimeToMinutes } from '../utils/bannerSchedule'

const POSITION_LAYOUT = {
  center: {
    container:
      'inset-0 flex flex-col items-center justify-center gap-2 px-4 py-5 sm:gap-2.5',
    align: 'items-center',
  },
  bottom_center: {
    container:
      'inset-x-0 bottom-0 flex flex-col items-center gap-1.5 px-4 pb-3.5 pt-10 sm:gap-2 sm:pb-4',
    align: 'items-center',
  },
  bottom_left: {
    container:
      'left-0 bottom-0 flex max-w-[88%] flex-col items-start gap-1.5 pl-3 pb-3.5 pt-10 sm:gap-2 sm:pl-3.5 sm:pb-4',
    align: 'items-start',
  },
  bottom_right: {
    container:
      'right-0 bottom-0 flex max-w-[88%] flex-col items-end gap-1.5 pr-3 pb-3.5 pt-10 sm:gap-2 sm:pr-3.5 sm:pb-4',
    align: 'items-end',
  },
  top_left: {
    container:
      'left-0 top-0 flex max-w-[88%] flex-col items-start gap-1.5 pl-3 pt-3.5 pb-8 sm:gap-2 sm:pl-3.5 sm:pt-4',
    align: 'items-start',
  },
  top_right: {
    container:
      'right-0 top-0 flex max-w-[88%] flex-col items-end gap-1.5 pr-3 pt-3.5 pb-8 sm:gap-2 sm:pr-3.5 sm:pt-4',
    align: 'items-end',
  },
}

const PILL_STYLES = {
  red: 'bg-[#E53935] text-white shadow-[0_4px_16px_rgba(229,57,53,0.5)] ring-1 ring-white/15',
  green: 'bg-[#43A047] text-white shadow-[0_4px_16px_rgba(67,160,71,0.5)] ring-1 ring-white/15',
  blue: 'bg-[#1E88E5] text-white shadow-[0_4px_16px_rgba(30,136,229,0.5)] ring-1 ring-white/15 font-mono tabular-nums tracking-tight',
}

function normalizePosition(value) {
  const raw = String(value ?? 'center')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  return POSITION_LAYOUT[raw] ? raw : 'center'
}

function formatTime12h(iso) {
  if (!iso) return '10:00 PM'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '10:00 PM'
  return d.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatHHMMSS(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function minutesUntilDailyStart(startTime, now = new Date()) {
  const start = parseTimeToMinutes(startTime)
  if (start == null) return null
  const cur = now.getHours() * 60 + now.getMinutes()
  if (cur < start) return start - cur
  return 24 * 60 - cur + start
}

function formatGreenPillText({ useTimer, startTime, timerWindowNow, now }) {
  if (!useTimer) return 'Bado masaa 2 kuanza'
  if (timerWindowNow) return 'Bado masaa 2 kuanza'
  const mins = minutesUntilDailyStart(startTime, now)
  if (mins == null) return 'Bado masaa 2 kuanza'
  const hours = Math.max(1, Math.ceil(mins / 60))
  return `Bado masaa ${hours} kuanza`
}

function formatRedPillText({ eventStartIso, eventPhase }) {
  if (eventPhase === 'upcoming' && eventStartIso) {
    return `COMING SOON ${formatTime12h(eventStartIso)}`
  }
  return 'COMING SOON 10:00 PM'
}

function formatBluePillText({ enableCountdown, eventStartIso, eventEndIso, clock, eventPhase }) {
  if (!enableCountdown) return '02:14:55'
  const now = clock
  if (eventPhase === 'upcoming' && eventStartIso) {
    const t0 = new Date(eventStartIso).getTime()
    if (!Number.isNaN(t0) && now < t0) return formatHHMMSS(t0 - now)
  }
  if (eventEndIso) {
    const t1 = new Date(eventEndIso).getTime()
    if (!Number.isNaN(t1) && now < t1) return formatHHMMSS(t1 - now)
  }
  return '02:14:55'
}

function RuntimePill({ variant, children, active }) {
  return (
    <span
      className={`inline-flex max-w-full items-center justify-center rounded-full px-3 py-1.5 text-[10px] font-bold uppercase leading-snug sm:px-3.5 sm:py-[7px] sm:text-[11px] ${PILL_STYLES[variant]} ${
        active ? 'opacity-100' : 'opacity-35'
      }`}
    >
      {children}
    </span>
  )
}

/**
 * Admin-only live preview of mobile runtime overlay pills on a banner image.
 */
export default function BannerRuntimeOverlayPreview({
  imageSrc,
  runtimePosition = 'center',
  useTimer = false,
  startTime = '09:00',
  endTime = '17:00',
  enableCountdown = false,
  eventStartIso = null,
  eventEndIso = null,
  clock = Date.now(),
  timerWindowNow = true,
  eventPhase = 'live',
}) {
  const position = normalizePosition(runtimePosition)
  const layout = POSITION_LAYOUT[position]

  const pills = useMemo(() => {
    const now = new Date(clock)
    const redText = formatRedPillText({ eventStartIso, eventPhase })
    const greenText = formatGreenPillText({
      useTimer,
      startTime,
      timerWindowNow,
      now,
    })
    const blueText = formatBluePillText({
      enableCountdown,
      eventStartIso,
      eventEndIso,
      clock,
      eventPhase,
    })

    const redActive = eventPhase === 'upcoming'
    const greenActive = Boolean(useTimer) && !timerWindowNow
    const blueActive = Boolean(enableCountdown)

    return {
      red: { text: redText, active: redActive },
      green: { text: greenText, active: greenActive },
      blue: { text: blueText, active: blueActive },
    }
  }, [
    clock,
    enableCountdown,
    eventEndIso,
    eventPhase,
    eventStartIso,
    startTime,
    timerWindowNow,
    useTimer,
  ])

  const positionLabel =
    runtimePosition === 'center'
      ? 'Center'
      : String(runtimePosition)
          .replace(/_/g, ' ')
          .replace(/\b\w/g, (c) => c.toUpperCase())

  return (
    <motion.div
      layout
      className="rounded-xl border border-amber-500/25 bg-slate-900/50 p-4 ring-1 ring-amber-500/10"
    >
      <motion.div
        key={position}
        initial={{ opacity: 0.92 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18 }}
        className="relative aspect-[16/9] w-full overflow-hidden rounded-xl border border-slate-600/70 bg-slate-800 shadow-inner sm:aspect-[21/9]"
      >
        {imageSrc ? (
          <img
            src={imageSrc}
            alt=""
            className="h-full w-full object-cover"
            draggable={false}
          />
        ) : (
          <motion.div
            key={imageSrc || 'empty'}
            className="flex h-full items-center justify-center bg-gradient-to-br from-slate-800 to-slate-900 px-4 text-center text-xs text-slate-500"
          >
            Upload a banner image to preview runtime pills
          </motion.div>
        )}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 via-black/10 to-black/25" />
        <motion.div
          layout
          className={`pointer-events-none absolute ${layout.container}`}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
        >
          <RuntimePill variant="red" active={pills.red.active}>
            {pills.red.text}
          </RuntimePill>
          <RuntimePill variant="green" active={pills.green.active}>
            {pills.green.text}
          </RuntimePill>
          <RuntimePill variant="blue" active={pills.blue.active}>
            {pills.blue.text}
          </RuntimePill>
        </motion.div>
      </motion.div>
      <p className="mt-2.5 text-[11px] leading-relaxed text-slate-500">
        <span className="font-semibold text-slate-400">Runtime overlay preview</span>
        {' · '}
        Position: <span className="text-amber-200/90">{positionLabel}</span>
        {' · '}
        Dimmed pills are hidden in the app for the current timer/countdown state.
      </p>
    </motion.div>
  )
}
