/**
 * Cross-process API response cache bust via PostgreSQL NOTIFY.
 * Ensures all API instances (VPS + Render) drop stale GET /api/channels JSON immediately.
 */
import pg from 'pg'
import { getPool } from '../db/pool.js'
import { invalidateApiCacheNamespace } from './apiResponseCache.js'

const { Client } = pg

const PG_CHANNEL = 'osmani_api_cache_bust'
const INSTANCE_ORIGIN = `cache-bust-${process.pid}-${Date.now().toString(36)}`

let wired = false
let applying = false
/** @type {import('pg').Client | null} */
let listenClient = null

function listenClientOptions() {
  const connectionString = process.env.DATABASE_URL
  if (!connectionString) return null
  const isLocal =
    /localhost|127\.0\.0\.1/i.test(connectionString) || process.env.PGSSLMODE === 'disable'
  return {
    connectionString,
    ...(isLocal ? {} : { ssl: { rejectUnauthorized: false } }),
  }
}

function applyBust(namespaces) {
  const list = Array.isArray(namespaces) ? namespaces : []
  for (const ns of list) {
    const s = String(ns ?? '').trim()
    if (s) invalidateApiCacheNamespace(s)
  }
}

/**
 * Synchronous cross-instance cache bust (await before returning mutation responses).
 * @param {string[]} namespaces
 */
export async function notifyApiCacheBust(namespaces) {
  const list = [...new Set((namespaces || []).map((n) => String(n ?? '').trim()).filter(Boolean))]
  if (!list.length) return
  applyBust(list)
  const pool = getPool()
  if (!pool) return
  try {
    const payload = JSON.stringify({ origin: INSTANCE_ORIGIN, namespaces: list, at: Date.now() })
    if (payload.length > 7800) {
      console.warn('[api-cache-bust] payload too large for NOTIFY')
      return
    }
    await pool.query('SELECT pg_notify($1, $2)', [PG_CHANNEL, payload])
  } catch (e) {
    console.error('[api-cache-bust] pg_notify failed:', e?.message || e)
  }
}

export async function wireApiCacheBustRelay() {
  if (wired) return
  wired = true

  const opts = listenClientOptions()
  if (!opts) {
    console.warn('[api-cache-bust] DATABASE_URL not set — relay disabled')
    return
  }

  try {
    listenClient = new Client(opts)
    listenClient.on('error', (err) => {
      console.error('[api-cache-bust] LISTEN client error:', err?.message || err)
    })
    await listenClient.connect()
    await listenClient.query(`LISTEN ${PG_CHANNEL}`)
    listenClient.on('notification', (msg) => {
      if (!msg?.payload || msg.channel !== PG_CHANNEL) return
      try {
        const data = JSON.parse(msg.payload)
        if (data?.origin === INSTANCE_ORIGIN) return
        applying = true
        applyBust(data?.namespaces)
        applying = false
      } catch (e) {
        applying = false
        console.error('[api-cache-bust] NOTIFY parse failed:', e?.message || e)
      }
    })
    console.log('[api-cache-bust] LISTEN active on', PG_CHANNEL)
  } catch (e) {
    console.error('[api-cache-bust] LISTEN setup failed:', e?.message || e)
    try {
      await listenClient?.end?.()
    } catch {
      /* ignore */
    }
    listenClient = null
  }
}

export async function closeApiCacheBustRelay() {
  if (listenClient) {
    try {
      await listenClient.end()
    } catch {
      /* ignore */
    }
    listenClient = null
  }
}

export function isApplyingRemoteCacheBust() {
  return applying
}
