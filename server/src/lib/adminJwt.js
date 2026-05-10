import crypto from 'node:crypto'

function base64urlEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
}

function base64urlDecode(str) {
  const pad = 4 - (str.length % 4 || 4)
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad === 4 ? 0 : pad)
  return Buffer.from(b64, 'base64')
}

export function signAdminJwt(payload, opts = {}) {
  const secret = String(process.env.ADMIN_JWT_SECRET || '').trim()
  if (!secret || secret.length < 16) {
    throw new Error('ADMIN_JWT_SECRET must be set (min 16 chars)')
  }
  const ttlSec = Number(opts.ttlSeconds) || 86400
  const body = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSec,
  }
  const header = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payloadB64 = base64urlEncode(JSON.stringify(body))
  const sig = crypto.createHmac('sha256', secret).update(`${header}.${payloadB64}`).digest()
  const sigB64 = base64urlEncode(sig)
  return `${header}.${payloadB64}.${sigB64}`
}

export function verifyAdminJwt(token) {
  const secret = String(process.env.ADMIN_JWT_SECRET || '').trim()
  if (!secret) return null
  const parts = String(token ?? '').split('.')
  if (parts.length !== 3) return null
  const [header, payloadB64, sigB64] = parts
  const expected = crypto.createHmac('sha256', secret).update(`${header}.${payloadB64}`).digest()
  let sig
  try {
    sig = base64urlDecode(sigB64)
  } catch {
    return null
  }
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null
  let payload
  try {
    payload = JSON.parse(base64urlDecode(payloadB64).toString('utf8'))
  } catch {
    return null
  }
  const now = Math.floor(Date.now() / 1000)
  if (payload.exp != null && Number(payload.exp) < now) return null
  return payload
}
