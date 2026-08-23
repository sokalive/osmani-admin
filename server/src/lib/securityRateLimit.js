/** Targeted rate limiting for security verification endpoints. */

const ipBuckets = new Map()
const deviceBuckets = new Map()

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] ?? req.socket?.remoteAddress ?? 'unknown')
    .split(',')[0]
    .trim()
}

function deviceKey(req) {
  const b = req.body && typeof req.body === 'object' ? req.body : {}
  return String(b.device_id ?? b.deviceId ?? req.query?.device_id ?? '').trim().slice(0, 128)
}

function checkBucket(map, key, { max, windowMs }) {
  const now = Date.now()
  let b = map.get(key)
  if (!b || now - b.start > windowMs) {
    b = { start: now, n: 0 }
  }
  b.n += 1
  map.set(key, b)
  if (b.n > max) {
    return { limited: true, retryAfterSec: Math.ceil((windowMs - (now - b.start)) / 1000) }
  }
  return { limited: false }
}

export function securityChallengeRateLimit(req, res, next) {
  const maxPerMin = Math.min(120, Math.max(5, Number(process.env.SECURITY_CHALLENGE_RATE_LIMIT_PER_MIN) || 30))
  const ip = clientIp(req)
  const r = checkBucket(ipBuckets, `challenge:${ip}`, { max: maxPerMin, windowMs: 60_000 })
  if (r.limited) {
    res.setHeader('Retry-After', String(r.retryAfterSec))
    return res.status(429).json({ ok: false, error: 'Too many challenge requests', code: 'rate_limited' })
  }
  next()
}

export function securityReportRateLimit(req, res, next) {
  const maxPerMinIp = Math.min(200, Math.max(10, Number(process.env.SECURITY_REPORT_RATE_LIMIT_PER_MIN_IP) || 60))
  const maxPerMinDevice = Math.min(60, Math.max(3, Number(process.env.SECURITY_REPORT_RATE_LIMIT_PER_MIN_DEVICE) || 12))
  const ip = clientIp(req)
  const device = deviceKey(req)

  const ipCheck = checkBucket(ipBuckets, `report:ip:${ip}`, { max: maxPerMinIp, windowMs: 60_000 })
  if (ipCheck.limited) {
    res.setHeader('Retry-After', String(ipCheck.retryAfterSec))
    return res.status(429).json({ ok: false, error: 'Too many security reports from this network', code: 'rate_limited' })
  }

  if (device) {
    const devCheck = checkBucket(deviceBuckets, `report:dev:${device}`, {
      max: maxPerMinDevice,
      windowMs: 60_000,
    })
    if (devCheck.limited) {
      res.setHeader('Retry-After', String(devCheck.retryAfterSec))
      return res.status(429).json({ ok: false, error: 'Too many security reports for this device', code: 'rate_limited' })
    }
  }

  next()
}

export function securityReportBodySizeLimit(maxBytes) {
  const limit = maxBytes ?? 16384
  return (req, res, next) => {
    const len = Number(req.headers['content-length'] || 0)
    if (len > limit) {
      return res.status(413).json({ ok: false, error: 'Security report payload too large', code: 'payload_too_large' })
    }
    next()
  }
}
