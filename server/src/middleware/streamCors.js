import cors from 'cors'

/** HLS playback routes — native APK/Exo; not subject to admin-panel origin allowlist. */
export function isStreamPlaybackPath(req) {
  const p = String(req.path || req.url || '').split('?')[0]
  return (
    p === '/stream-direct' ||
    p.startsWith('/stream-proxy') ||
    p === '/hls/seg' ||
    p.startsWith('/hls/seg/')
  )
}

/** Allow any/missing Origin (null, exp://, localhost, etc.) for native players. */
export const streamPlaybackCors = cors({
  origin(_origin, callback) {
    callback(null, true)
  },
  methods: ['GET', 'HEAD', 'OPTIONS'],
  credentials: true,
})
