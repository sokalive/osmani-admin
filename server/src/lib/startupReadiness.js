/** True after deferred startup (DB files, billing tables, live-sync relay) completes. */
let startupReady = false
let startupError = null

export function isStartupReady() {
  return startupReady
}

export function getStartupError() {
  return startupError
}

export function markStartupReady() {
  startupReady = true
  startupError = null
}

export function markStartupFailed(err) {
  startupError = err ? String(err.message || err) : 'startup_failed'
}

export function isRenderRuntime() {
  if (String(process.env.RENDER || '').trim().toLowerCase() === 'true') return true
  if (String(process.env.RENDER_SERVICE_ID || '').trim()) return true
  if (String(process.env.RENDER_EXTERNAL_URL || '').includes('onrender.com')) return true
  return false
}

function envFlag(name, defaultWhenUnset = false) {
  const raw = process.env[name]
  if (raw == null || String(raw).trim() === '') return defaultWhenUnset
  const v = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(v)) return true
  if (['0', 'false', 'no', 'off'].includes(v)) return false
  return defaultWhenUnset
}

/** Render: off by default — VPS runs warm-cache on startup. */
export function shouldWarmApiCachesOnStartup() {
  if (isRenderRuntime()) return envFlag('WARM_API_CACHE_ON_STARTUP', false)
  return envFlag('WARM_API_CACHE_ON_STARTUP', true)
}

/** Render: defer catalog routing burst until deferred startup completes. */
export function shouldDeferMpingoRoutingStartupSync() {
  return isRenderRuntime() && !envFlag('MPINGO_ROUTING_STARTUP_IMMEDIATE', false)
}

/** Never exit the process on Render — platform restarts are expensive for legacy SSE clients. */
export function renderSuppressFatalExit(code, reason) {
  if (!isRenderRuntime()) {
    process.exit(code)
    return
  }
  console.error(`[render-guard] suppressed exit(${code}): ${reason}`)
}

export function wireRenderProcessGuards() {
  if (!isRenderRuntime()) return
  process.on('uncaughtException', (err) => {
    console.error('[render-guard] uncaughtException:', err?.stack || err)
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[render-guard] unhandledRejection:', reason)
  })
  console.info('[render-guard] fatal exit suppression + process error logging active')
}
