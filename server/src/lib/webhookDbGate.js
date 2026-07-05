/**
 * Bounded concurrency gate for SonicPesa webhook DB work — prevents pool stampede under burst load.
 */
import { getPoolStats, poolMaxConnections } from '../db/pool.js'

const maxSlots = Math.max(
  3,
  Math.min(
    25,
    Number(process.env.SONICPESA_WEBHOOK_DB_SLOTS) ||
      Math.floor(poolMaxConnections() * 0.65),
  ),
)
const slotTimeoutMs = Math.max(5000, Number(process.env.SONICPESA_WEBHOOK_DB_SLOT_TIMEOUT_MS) || 45_000)

let inFlight = 0
/** @type {Array<{ resolve: () => void, timer: NodeJS.Timeout }>} */
const waitQueue = []

function releaseSlot() {
  inFlight = Math.max(0, inFlight - 1)
  while (inFlight < maxSlots && waitQueue.length > 0) {
    const next = waitQueue.shift()
    if (!next) break
    clearTimeout(next.timer)
    inFlight++
    next.resolve()
  }
}

function acquireSlot() {
  if (inFlight < maxSlots) {
    inFlight++
    return Promise.resolve()
  }
  return new Promise((resolve, reject) => {
    const entry = {
      resolve: () => resolve(),
      timer: setTimeout(() => {
        const idx = waitQueue.indexOf(entry)
        if (idx >= 0) waitQueue.splice(idx, 1)
        reject(new Error('webhook_db_slot_timeout'))
      }, slotTimeoutMs),
    }
    waitQueue.push(entry)
  })
}

/** Run fn while holding one webhook DB slot (queues in-process instead of stampeding pg pool). */
export async function withWebhookDbSlot(fn) {
  await acquireSlot()
  try {
    return await fn()
  } finally {
    releaseSlot()
  }
}

export function getWebhookDbGateStats() {
  return {
    maxSlots,
    inFlight,
    queued: waitQueue.length,
    slotTimeoutMs,
    pool: getPoolStats(),
  }
}

export function isPoolPressureError(err) {
  const msg = String(err?.message || err || '').toLowerCase()
  return (
    msg.includes('timeout') ||
    msg.includes('webhook_db_slot_timeout') ||
    msg.includes('too many clients') ||
    err?.code === '53300'
  )
}
