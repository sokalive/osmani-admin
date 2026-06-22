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
  return String(process.env.RENDER || '').trim().toLowerCase() === 'true'
}
