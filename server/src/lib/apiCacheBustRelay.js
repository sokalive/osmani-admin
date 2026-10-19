/**
 * Cross-process API response cache bust via PostgreSQL NOTIFY.
 */
import { invalidateApiCacheNamespace } from './apiResponseCache.js'
import { createPgListenRelay } from './pgListenRelay.js'

const PG_CHANNEL = 'osmani_api_cache_bust'
const INSTANCE_ORIGIN = `cache-bust-${process.pid}-${Date.now().toString(36)}`

let wired = false
let applying = false

function applyBust(namespaces) {
  const list = Array.isArray(namespaces) ? namespaces : []
  for (const ns of list) {
    const s = String(ns ?? '').trim()
    if (s) invalidateApiCacheNamespace(s)
  }
}

const relay = createPgListenRelay({
  channel: PG_CHANNEL,
  logPrefix: '[api-cache-bust]',
  onNotification(msg) {
    if (!msg?.payload || msg.channel !== PG_CHANNEL) return
    try {
      const data = JSON.parse(msg.payload)
      if (data?.origin === INSTANCE_ORIGIN) return
      applying = true
      applyBust(data?.namespaces)
      applying = false
    } catch (e) {
      applying = false
      relay.noteFailure(e)
      console.error('[api-cache-bust] NOTIFY parse failed:', e?.message || e)
    }
  },
})

/**
 * Synchronous local bust, then cross-instance NOTIFY.
 * @param {string[]} namespaces
 */
export async function notifyApiCacheBust(namespaces) {
  const list = [...new Set((namespaces || []).map((n) => String(n ?? '').trim()).filter(Boolean))]
  if (!list.length) return
  applyBust(list)
  await relay.notify({ origin: INSTANCE_ORIGIN, namespaces: list, at: Date.now() })
}

export function getApiCacheBustRelayStatus() {
  return { ...relay.status(), channel: PG_CHANNEL }
}

export async function wireApiCacheBustRelay() {
  if (wired) return
  wired = true
  await relay.start()
}

export async function closeApiCacheBustRelay() {
  await relay.close()
}

export function isApplyingRemoteCacheBust() {
  return applying
}
