/**
 * Cross-process fan-out for deviceSubscriptionBus (PM2 workers / VPS + Render).
 * Uses PostgreSQL NOTIFY on a dedicated Client — does not consume query pool slots.
 */
import pg from 'pg'
import { getPool } from '../db/pool.js'
import { deviceSubscriptionBus } from './deviceSubscriptionBus.js'

const { Client } = pg

const PG_CHANNEL = 'osmani_device_subscription'
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

async function notifyPeers(payload) {
  const pool = getPool()
  if (!pool || !payload?.deviceId) return
  try {
    const body = JSON.stringify({ origin: INSTANCE_ORIGIN, payload })
    if (body.length > 7800) {
      console.warn('[device-subscription-relay] packet too large, skipping relay')
      return
    }
    await pool.query('SELECT pg_notify($1, $2)', [PG_CHANNEL, body])
  } catch (e) {
    console.error('[device-subscription-relay] pg_notify failed:', e?.message || e)
  }
}

/**
 * Wire in-process bus → NOTIFY, and NOTIFY → local bus replay on peer instances.
 */
export async function wireDeviceSubscriptionRelay() {
  if (wired) return
  wired = true

  const pool = getPool()
  if (!pool) {
    console.warn('[device-subscription-relay] DATABASE_URL not set — relay disabled')
    return
  }

  deviceSubscriptionBus.on('update', (payload) => {
    if (relaying || !payload?.deviceId) return
    void notifyPeers(payload)
  })

  deviceSubscriptionBus.on('manual_gift', (payload) => {
    if (relaying || !payload?.deviceId) return
    void notifyPeers({ ...payload, kind: 'manual_gift' })
  })

  const opts = listenClientOptions()
  if (!opts) return

  try {
    listenClient = new Client(opts)
    listenClient.on('error', (err) => {
      console.error('[device-subscription-relay] LISTEN client error:', err?.message || err)
    })
    await listenClient.connect()
    await listenClient.query(`LISTEN ${PG_CHANNEL}`)
    listenClient.on('notification', (msg) => {
      if (!msg?.payload) return
      try {
        const data = JSON.parse(msg.payload)
        if (!data?.payload || data.origin === INSTANCE_ORIGIN) return
        relaying = true
        const p = data.payload
        if (p.kind === 'manual_gift') {
          deviceSubscriptionBus.emit('manual_gift', p)
        } else {
          deviceSubscriptionBus.emit('update', p)
        }
        relaying = false
      } catch (e) {
        relaying = false
        console.error('[device-subscription-relay] NOTIFY parse failed:', e?.message || e)
      }
    })
    console.log('[device-subscription-relay] LISTEN active on', PG_CHANNEL)
  } catch (e) {
    console.error('[device-subscription-relay] LISTEN setup failed:', e?.message || e)
    try {
      await listenClient?.end?.()
    } catch {
      /* ignore */
    }
    listenClient = null
  }
}

export async function closeDeviceSubscriptionRelay() {
  if (listenClient) {
    try {
      await listenClient.end()
    } catch {
      /* ignore */
    }
    listenClient = null
  }
}
