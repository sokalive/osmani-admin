import { AnimatePresence, motion } from 'framer-motion'

const easeOut = [0.16, 1, 0.3, 1]

const transition = {
  duration: 0.3,
  ease: easeOut,
}

const badgeInner =
  'inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold tracking-tight whitespace-nowrap ring-1 ring-white/15'

/**
 * Outer motion handles entry (fade + slide). Inner span runs continuous pulse-glow.
 */
function ModeStatusBadges({ isFreeMode, isEmergencyMode, isMaintenanceMode }) {
  return (
    <div className="flex min-h-[44px] flex-wrap items-center gap-2">
      <AnimatePresence mode="popLayout" initial={false}>
        {isFreeMode ? (
          <motion.span
            key="status-free"
            layout
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={transition}
            className="inline-block"
          >
            <span
              className={`${badgeInner} bg-[#16a34a] text-white status-badge-pulse-free`}
            >
              <span className="text-emerald-100" aria-hidden>
                ●
              </span>
              <span>FREE MODE ACTIVE</span>
            </span>
          </motion.span>
        ) : null}

        {isEmergencyMode ? (
          <motion.span
            key="status-emergency"
            layout
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={transition}
            className="inline-block"
          >
            <span
              className={`${badgeInner} bg-[#ef4444] text-white status-badge-pulse-emergency`}
            >
              <span className="text-lg leading-none" aria-hidden>
                🚫
              </span>
              <span>ALL CHANNELS DISABLED</span>
            </span>
          </motion.span>
        ) : null}

        {isMaintenanceMode ? (
          <motion.span
            key="status-maintenance"
            layout
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            transition={transition}
            className="inline-block"
          >
            <span
              className={`${badgeInner} bg-[#f59e0b] text-slate-950 status-badge-pulse-maintenance`}
            >
              <span className="text-lg leading-none" aria-hidden>
                🛠
              </span>
              <span>MAINTENANCE MODE ACTIVE</span>
            </span>
          </motion.span>
        ) : null}
      </AnimatePresence>
    </div>
  )
}

export default ModeStatusBadges
