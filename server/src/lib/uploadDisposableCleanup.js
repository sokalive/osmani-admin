import { cleanupDisposableUploadArtifacts } from './uploadStorageForensics.js'
import { isRenderRuntime } from './startupReadiness.js'

let scheduled = false

/**
 * Periodic cleanup of write-probe and temp artifacts under UPLOADS_DIR.
 */
export function scheduleDisposableUploadCleanup() {
  if (scheduled) return
  if (isRenderRuntime() && String(process.env.UPLOAD_DISPOSABLE_CLEANUP || '').trim() !== '1') {
    return
  }
  scheduled = true
  const intervalMs = Math.max(
    60 * 60 * 1000,
    Number(process.env.UPLOAD_DISPOSABLE_CLEANUP_INTERVAL_MS) || 6 * 60 * 60 * 1000,
  )
  const run = () => {
    void cleanupDisposableUploadArtifacts()
      .then((out) => {
        if (out.removed_count > 0) {
          console.log(
            `[uploads] disposable cleanup removed=${out.removed_count} reclaimed=${out.reclaimed_bytes}B`,
          )
        }
      })
      .catch((e) => console.warn('[uploads] disposable cleanup failed:', e?.message || e))
  }
  run()
  const timer = setInterval(run, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
}
