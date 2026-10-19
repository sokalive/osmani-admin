import pg from 'pg'
import { getPool } from '../db/pool.js'

const { Client } = pg

export function redactRelayError(err) {
  return String(err?.message || err || 'unknown')
    .replace(/postgres(?:ql)?:\/\/\S+/gi, '[redacted]')
    .slice(0, 180)
}

/**
 * Dedicated LISTEN client with reconnect. Query-pool NOTIFY stays separate so a
 * dropped listener does not silently stop cross-worker cache and SSE delivery.
 */
export function createPgListenRelay({ channel, logPrefix, onNotification }) {
  let client = null
  let closing = false
  let reconnectTimer = null
  let attempt = 0
  let listening = false
  let notifyFailures = 0
  let listenFailures = 0
  let lastError = null

  function scheduleReconnect() {
    if (closing || reconnectTimer) return
    attempt += 1
    const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null
      void connect()
    }, delay)
    reconnectTimer.unref?.()
  }

  async function connect() {
    if (closing) return
    const connectionString = process.env.DATABASE_URL
    if (!connectionString) {
      console.warn(`${logPrefix} DATABASE_URL not set — relay disabled`)
      return
    }
    const isLocal =
      /localhost|127\.0\.0\.1/i.test(connectionString) || process.env.PGSSLMODE === 'disable'
    const next = new Client({
      connectionString,
      ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
    })
    next.on('error', (err) => {
      listening = false
      listenFailures += 1
      lastError = redactRelayError(err)
      console.error(`${logPrefix} LISTEN client error:`, lastError)
      if (client === next) client = null
      void next.end().catch(() => {})
      scheduleReconnect()
    })
    next.on('end', () => {
      listening = false
      if (client === next) client = null
      if (!closing) scheduleReconnect()
    })
    try {
      await next.connect()
      await next.query(`LISTEN ${channel}`)
      client = next
      listening = true
      attempt = 0
      next.on('notification', (msg) => {
        try {
          onNotification(msg)
        } catch (e) {
          console.error(`${logPrefix} notification handler failed:`, redactRelayError(e))
        }
      })
      console.log(`${logPrefix} LISTEN active on`, channel)
    } catch (e) {
      listening = false
      listenFailures += 1
      lastError = redactRelayError(e)
      console.error(`${logPrefix} LISTEN setup failed:`, lastError)
      try {
        await next.end()
      } catch {
        /* ignore */
      }
      scheduleReconnect()
    }
  }

  return {
    start: connect,
    status() {
      return { listening, notifyFailures, listenFailures, lastError }
    },
    noteFailure(err) {
      notifyFailures += 1
      lastError = redactRelayError(err)
    },
    async notify(payloadObject) {
      const pool = getPool()
      if (!pool) return false
      try {
        const payload = JSON.stringify(payloadObject)
        if (payload.length > 7800) {
          notifyFailures += 1
          lastError = 'payload_too_large'
          console.warn(`${logPrefix} payload too large for NOTIFY`)
          return false
        }
        await pool.query('SELECT pg_notify($1, $2)', [channel, payload])
        return true
      } catch (e) {
        notifyFailures += 1
        lastError = redactRelayError(e)
        console.error(`${logPrefix} pg_notify failed:`, lastError)
        return false
      }
    },
    async close() {
      closing = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = null
      listening = false
      const current = client
      client = null
      try {
        await current?.end()
      } catch {
        /* ignore */
      }
    },
  }
}
