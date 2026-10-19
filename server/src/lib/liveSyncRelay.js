import { getPool } from '../db/pool.js'
import { liveSyncBus } from './liveSyncBus.js'
import { createPgListenRelay } from './pgListenRelay.js'

const PG_CHANNEL = 'osmani_live_sync'
const INSTANCE_ORIGIN = `${process.pid}-${Date.now().toString(36)}`

let wired = false
let relaying = false

const relay = createPgListenRelay({
  channel: PG_CHANNEL,
  logPrefix: '[live-sync-relay]',
  onNotification(msg) {
    if (!msg?.payload) return
    try {
      const data = JSON.parse(msg.payload)
      if (!data?.packet || data.origin === INSTANCE_ORIGIN) return
      relaying = true
      liveSyncBus.replay(data.packet)
      relaying = false
    } catch (e) {
      relaying = false
      relay.noteFailure(e)
      console.error('[live-sync-relay] NOTIFY parse failed:', e?.message || e)
    }
  },
})

async function notifyPeers(packet) {
  const pool = getPool()
  if (!pool || !packet) return
  await relay.notify({ origin: INSTANCE_ORIGIN, packet })
}

/** Await cross-instance live sync relay (call after local publish). */
export async function notifyLiveSyncPeers(packet) {
  await notifyPeers(packet)
}

export function getLiveSyncRelayStatus() {
  return { ...relay.status(), channel: PG_CHANNEL }
}

/**
 * Fan-out liveSyncBus events across API processes via PostgreSQL NOTIFY/LISTEN.
 * LISTEN uses a dedicated client outside the query pool and reconnects after errors.
 */
export async function wireLiveSyncRelay() {
  if (wired) return
  wired = true

  const pool = getPool()
  if (!pool) {
    console.warn('[live-sync-relay] DATABASE_URL not set — realtime relay disabled (single instance)')
    return
  }

  // Ordinary TTL heartbeats stay local: UPSERT already wrote Postgres.
  liveSyncBus.on('sync', (packet) => {
    if (relaying || packet?.relayed === true) return
    if (String(packet?.event || '') === 'analytics.session_heartbeat') return
    void notifyPeers(packet)
  })

  await relay.start()
}

export async function closeLiveSyncRelay() {
  await relay.close()
}
