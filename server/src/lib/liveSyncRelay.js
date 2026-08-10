import pg from 'pg'
import { getPool } from '../db/pool.js'
import { liveSyncBus } from './liveSyncBus.js'

const { Client } = pg

const PG_CHANNEL = 'osmani_live_sync'
const INSTANCE_ORIGIN = `${process.pid}-${Date.now().toString(36)}`

let wired = false
let relaying = false
/** @type {import('pg').Client | null} */
let listenClient = null

function listenClientOptions() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return null
  const isLocal =
    /localhost|127\.0\.0\.1/i.test(connectionString) ||
    process.env.PGSSLMODE === 'disable'
  return {
    connectionString,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  }
}

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

/** Await cross-instance live sync relay (call after local publish). */
export async function notifyLiveSyncPeers(packet) {
  await notifyPeers(packet)
}

/**
 * Fan-out liveSyncBus events across Render + VPS via PostgreSQL NOTIFY/LISTEN.
 * Both instances share the same DB; in-memory EventEmitter alone cannot cross hosts.
 *
 * LISTEN uses a dedicated pg.Client (not the query pool) so one permanent slot is not
 * removed from PG_POOL_MAX checkout capacity.
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

  const opts = listenClientOptions()
  if (!opts) return

  try {
    listenClient = new Client(opts)
    listenClient.on('error', (err) => {
      console.error('[live-sync-relay] LISTEN client error:', err?.message || err)
    })
    await listenClient.connect()
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
    console.log('[live-sync-relay] LISTEN active on', PG_CHANNEL, '(dedicated client, outside pool)')
  } catch (e) {
    console.error('[live-sync-relay] LISTEN setup failed:', e?.message || e)
    try {
      await listenClient?.end?.()
    } catch {
      /* ignore */
    }
    listenClient = null
  }
}

export async function closeLiveSyncRelay() {
  if (listenClient) {
    try {
      await listenClient.end()
    } catch {
      /* ignore */
    }
    listenClient = null
  }
}
