import { liveSyncBus } from './liveSyncBus.js'
import { invalidateApiCacheNamespace } from './apiResponseCache.js'

/** liveSync `event` → cache namespaces to purge (admin writes stay visible quickly). */
const EVENT_NAMESPACES = {
  'config.channels_changed': ['channels', 'runtime-app-modes'],
  'config.banners_changed': ['banners'],
  'config.plans_changed': ['plans'],
  'config.payment_providers_changed': ['payment-providers', 'checkout-providers'],
  'config.checkout_payment_provider_changed': ['checkout-providers'],
  'whatsapp_settings_changed': ['whatsapp-settings', 'settings-whatsapp', 'settings-public'],
  'popup_settings_changed': ['settings-popup', 'settings-public'],
  'config.settings_changed': ['runtime-app-modes', 'settings-public'],
  'config.trial_watch_changed': ['runtime-app-modes'],
  'server_health_changed': ['runtime-app-modes'],
}

let wired = false

export function wireApiCacheInvalidation() {
  if (wired) return
  wired = true

  liveSyncBus.on('sync', (packet) => {
    const event = String(packet?.event || '').trim()
    const namespaces = EVENT_NAMESPACES[event]
    if (!namespaces?.length) return
    for (const ns of namespaces) {
      const removed = invalidateApiCacheNamespace(ns)
      if (removed > 0 && String(process.env.API_CACHE_DEBUG || '') === '1') {
        console.info(`[api-cache] invalidated ${removed} entries for ${ns} (${event})`)
      }
    }
  })
}
