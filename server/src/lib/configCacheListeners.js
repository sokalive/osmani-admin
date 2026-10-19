import { liveSyncBus } from './liveSyncBus.js'
import { invalidatePhoneGateCache } from './phoneGateSettings.js'
import { invalidateOmbaKifurushiCache } from './subscriptionRequestSettings.js'
import { invalidateTrialWatchSettingsCache } from './trialWatchSettings.js'
import { invalidateGlobalModesCache } from './globalAppModesPersistence.js'
import { invalidateAppSettingsCache } from '../routes/appUpdate.js'

let wired = false

/**
 * Process-local settings caches must drop on this worker and on a relayed event.
 * The API response cache is handled separately by wireApiCacheInvalidation.
 */
export function wireConfigCacheListeners() {
  if (wired) return
  wired = true
  liveSyncBus.on('sync', (packet) => {
    const event = String(packet?.event || '')
    if (event === 'phone_gate_changed') invalidatePhoneGateCache()
    else if (event === 'omba_kifurushi_settings_changed') invalidateOmbaKifurushiCache()
    else if (event === 'config.trial_watch_changed') invalidateTrialWatchSettingsCache()
    else if (event === 'config.settings_changed') invalidateGlobalModesCache()
    else if (event === 'config.app_update_changed') invalidateAppSettingsCache()
  })
}
