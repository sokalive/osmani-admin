import { getPool } from '../db/pool.js'
import { liveSyncBus } from './liveSyncBus.js'

const PG_CHANNEL = 'osmani_live_sync'
const INSTANCE_ORIGIN = `${process.pid}-${Date.now().toString(36)}`

let wired = false
let relaying = false

async function notifyPeers(packet) {
  const pool = getPool()
  if (!pool || !packet) return
  try {
    const payload = JSON.stringify({ origin: INSTANCE_ORIGIN, packet })
    if (payload.length > 7800) {
      console.warn('[live-sync-relay] packet too large for NOTIFY, skipping relay')
      return
    }
    await pool.query('SELECT pg_notify($1, $2)', [PG_CHANNEL, payload])
  } catch (e) {
    console.error('[live-sync-relay] pg_notify failed:', e?.message || e)
  }
}

/**
 * Fan-out liveSyncBus events across Render + VPS via PostgreSQL NOTIFY/LISTEN.
 * Both instances share the same DB; in-memory EventEmitter alone cannot cross hosts.
 */
export async function wireLiveSyncRelay() {
  if (wired) return
  wired = true

  const pool = getPool()
  if (!pool) {
    console.warn('[live-sync-relay] DATABASE_URL not set — realtime relay disabled (single instance)')
    return
  }

  liveSyncBus.on('sync', (packet) => {
    if (relaying || packet?.relayed === true) return
    void notifyPeers(packet)
  })

  let listenClient
  try {
    listenClient = await pool.connect()
    listenClient.on('error', (err) => {
      console.error('[live-sync-relay] LISTEN client error:', err?.message || err)
    })
    await listenClient.query(`LISTEN ${PG_CHANNEL}`)
    listenClient.on('notification', (msg) => {
      if (!msg?.payload) return
      try {
        const data = JSON.parse(msg.payload)
        if (!data?.packet || data.origin === INSTANCE_ORIGIN) return
        relaying = true
        liveSyncBus.replay(data.packet)
        relaying = false
      } catch (e) {
        relaying = false
        console.error('[live-sync-relay] NOTIFY parse failed:', e?.message || e)
      }
    })
    console.log('[live-sync-relay] LISTEN active on', PG_CHANNEL)
  } catch (e) {
    console.error('[live-sync-relay] LISTEN setup failed:', e?.message || e)
    listenClient?.release?.()
  }
}
