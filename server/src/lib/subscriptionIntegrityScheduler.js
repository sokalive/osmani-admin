/**
 * Schedules the read-only integrity audit three times daily (EAT):
 * Morning 06:00, Afternoon 14:00, Night 22:00 Africa/Dar_es_Salaam.
 */
import { INTEGRITY_AUDIT_EAT_HOURS } from './subscriptionHardeningConstants.js'
import { SUBSCRIPTION_TZ } from './subscriptionStacking.js'

let timer = null
let running = false
const firedSlots = new Set()

function eatParts(nowMs = Date.now()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: SUBSCRIPTION_TZ || 'Africa/Dar_es_Salaam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  })
  const parts = Object.fromEntries(fmt.formatToParts(new Date(nowMs)).map((p) => [p.type, p.value]))
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
  }
}

function slotName(hour) {
  if (hour === 6) return 'morning'
  if (hour === 14) return 'afternoon'
  if (hour === 22) return 'night'
  return `hour_${hour}`
}

async function tick() {
  if (running) return
  if (process.env.SUBSCRIPTION_INTEGRITY_AUDIT_ENABLED === '0') return
  const { ymd, hour } = eatParts()
  if (!INTEGRITY_AUDIT_EAT_HOURS.includes(hour)) return
  const key = `${ymd}:${hour}`
  if (firedSlots.has(key)) return
  // Keep set bounded
  if (firedSlots.size > 12) firedSlots.clear()
  firedSlots.add(key)
  running = true
  try {
    const { runSubscriptionIntegrityAudit } = await import('./subscriptionIntegrityAudit.js')
    await runSubscriptionIntegrityAudit({ slot: slotName(hour) })
    // SAFE AUTO FIX (System Health Center): cache/monitoring maintenance only.
    // Never repairs subscriptions, payments, expiry, or entitlement records.
    try {
      const { isSafeAutoFixEnabled, runSafeAutoFixBundle } = await import('./systemHealthCenter.js')
      if (await isSafeAutoFixEnabled()) {
        await runSafeAutoFixBundle({ mode: 'auto', performedBy: 'safe_auto_fix' })
      }
    } catch (autoErr) {
      console.error('[integrity-audit-scheduler] safe auto fix:', autoErr?.message || autoErr)
    }
  } catch (e) {
    console.error('[integrity-audit-scheduler]', e?.message || e)
  } finally {
    running = false
  }
}

/**
 * Start the permanent scheduler (idempotent). Safe on single PM2 fork instance.
 */
export function startSubscriptionIntegrityAuditScheduler() {
  if (timer) return { started: false, already: true }
  if (process.env.SUBSCRIPTION_INTEGRITY_AUDIT_ENABLED === '0') {
    console.info('[integrity-audit-scheduler] disabled via SUBSCRIPTION_INTEGRITY_AUDIT_ENABLED=0')
    return { started: false, disabled: true }
  }
  const intervalMs = Math.max(30_000, Number(process.env.INTEGRITY_AUDIT_TICK_MS) || 60_000)
  timer = setInterval(() => {
    void tick()
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
  // Opportunistic first check shortly after boot (does not force off-slot runs).
  setTimeout(() => void tick(), 15_000).unref?.()
  console.log(
    `[integrity-audit-scheduler] armed — EAT hours ${INTEGRITY_AUDIT_EAT_HOURS.join(',')}; tick ${intervalMs}ms`,
  )
  return { started: true, hours_eat: [...INTEGRITY_AUDIT_EAT_HOURS], interval_ms: intervalMs }
}

export function stopSubscriptionIntegrityAuditScheduler() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
