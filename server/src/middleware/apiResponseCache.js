import {
  invalidateApiCacheNamespace,
  serveFromApiCacheOrContinue,
} from '../lib/apiResponseCache.js'

const TTL = {
  channels: Math.max(1000, Number(process.env.API_CACHE_CHANNELS_TTL_MS) || 3000),
  banners: Math.max(5000, Number(process.env.API_CACHE_BANNERS_TTL_MS) || 20_000),
  plans: Math.max(5000, Number(process.env.API_CACHE_PLANS_TTL_MS) || 15_000),
  'payment-providers': Math.max(5000, Number(process.env.API_CACHE_PAYMENT_PROVIDERS_TTL_MS) || 15_000),
  'whatsapp-settings': Math.max(5000, Number(process.env.API_CACHE_WHATSAPP_TTL_MS) || 30_000),
  'settings-whatsapp': Math.max(5000, Number(process.env.API_CACHE_WHATSAPP_TTL_MS) || 30_000),
  'settings-popup': Math.max(5000, Number(process.env.API_CACHE_POPUP_TTL_MS) || 30_000),
  'settings-public': Math.max(5000, Number(process.env.API_CACHE_SETTINGS_PUBLIC_TTL_MS) || 30_000),
  'runtime-app-modes': Math.max(500, Number(process.env.API_CACHE_APP_MODES_TTL_MS) || 2000),
}

/**
 * Cache only exact public catalog GET (e.g. GET /api/channels, not POST or sub-routes).
 */
export function apiResponseCacheExact(namespace, { path = '/' } = {}) {
  const ttlMs = TTL[namespace] ?? 20_000
  return (req, res, next) => {
    if (req.method !== 'GET') return next()
    const p = req.path || '/'
    if (p !== path) return next()
    return serveFromApiCacheOrContinue(namespace, req, res, next, ttlMs)
  }
}

export function apiResponseCacheNamespace(namespace) {
  const ttlMs = TTL[namespace] ?? 20_000
  return (req, res, next) => {
    if (req.method !== 'GET') return next()
    return serveFromApiCacheOrContinue(namespace, req, res, next, ttlMs)
  }
}

export { invalidateApiCacheNamespace }
