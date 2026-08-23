import crypto from 'node:crypto'
import {
  playIntegrityCredentialsConfigured,
  playIntegrityPackageName,
} from './securityVerificationConfig.js'

function text(v, max = 512) {
  return String(v ?? '')
    .trim()
    .slice(0, max)
}

function loadServiceAccountCredentials() {
  const raw = String(process.env.GOOGLE_PLAY_INTEGRITY_CREDENTIALS_JSON || '').trim()
  if (raw) {
    try {
      return JSON.parse(raw)
    } catch {
      return null
    }
  }
  return null
}

async function getGoogleAccessToken(credentials) {
  const now = Math.floor(Date.now() / 1000)
  const header = { alg: 'RS256', typ: 'JWT' }
  const claim = {
    iss: credentials.client_email,
    scope: 'https://www.googleapis.com/auth/playintegrity',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now,
  }
  const enc = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url')
  const unsigned = `${enc(header)}.${enc(claim)}`
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(unsigned)
  sign.end()
  const signature = sign.sign(credentials.private_key, 'base64url')
  const jwt = `${unsigned}.${signature}`

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok || !body.access_token) {
    throw new Error(body.error_description || body.error || 'Google OAuth token failed')
  }
  return body.access_token
}

/** Sanitize verdict for storage — no raw token, minimal fields only. */
function sanitizeVerdictPayload(payload, packageName) {
  const tokenPayload = payload?.tokenPayloadExternal || {}
  const appIntegrity = tokenPayload.appIntegrity || {}
  const deviceIntegrity = tokenPayload.deviceIntegrity || {}
  const accountDetails = tokenPayload.accountDetails || {}
  const requestDetails = tokenPayload.requestDetails || {}

  return {
    package_name: packageName,
    app_recognition_verdict: text(appIntegrity.appRecognitionVerdict, 64),
    certificate_sha256_digest: Array.isArray(appIntegrity.certificateSha256Digest)
      ? appIntegrity.certificateSha256Digest.slice(0, 3).map((x) => text(x, 128))
      : [],
    device_recognition_verdict: Array.isArray(deviceIntegrity.deviceRecognitionVerdict)
      ? deviceIntegrity.deviceRecognitionVerdict.slice(0, 8).map((x) => text(x, 64))
      : [],
    app_licensing_verdict: text(accountDetails.appLicensingVerdict, 64),
    request_package_name: text(requestDetails.requestPackageName, 128),
    request_nonce_present: Boolean(requestDetails.nonce),
    verified_at: new Date().toISOString(),
  }
}

function evaluateIntegrityVerdict(sanitized, expectedNonce) {
  const reasons = []
  let passed = true

  const appVerdict = String(sanitized.app_recognition_verdict || '').toUpperCase()
  if (appVerdict && appVerdict !== 'PLAY_RECOGNIZED') {
    passed = false
    reasons.push(`app_not_recognized:${appVerdict}`)
  }

  const deviceVerdicts = sanitized.device_recognition_verdict || []
  if (
    deviceVerdicts.some((v) =>
      ['MEETS_DEVICE_INTEGRITY', 'MEETS_STRONG_INTEGRITY', 'MEETS_BASIC_INTEGRITY'].includes(
        String(v).toUpperCase(),
      ),
    )
  ) {
    // acceptable device integrity present
  } else if (deviceVerdicts.length > 0) {
    passed = false
    reasons.push(`device_integrity_failed:${deviceVerdicts.join(',')}`)
  } else {
    reasons.push('device_integrity_unknown')
  }

  if (expectedNonce && !sanitized.request_nonce_present) {
    passed = false
    reasons.push('missing_request_nonce')
  }

  return {
    passed,
    status: passed ? 'passed' : 'failed',
    reasons,
  }
}

/**
 * Verify Play Integrity token server-side via Google API.
 * Returns { configured, ok, status, verdict, error?, reasons? }
 */
export async function verifyPlayIntegrityToken(integrityToken, opts = {}) {
  const token = text(integrityToken, 8192)
  const packageName = text(opts.packageName || playIntegrityPackageName(), 128)
  const expectedNonce = text(opts.expectedNonce || opts.nonce, 256)

  if (!token) {
    return { configured: playIntegrityCredentialsConfigured(), ok: false, status: 'missing_token', error: 'integrity_token required' }
  }

  if (!playIntegrityCredentialsConfigured()) {
    return {
      configured: false,
      ok: false,
      status: 'unavailable',
      error: 'Play Integrity credentials not configured (GOOGLE_PLAY_INTEGRITY_CREDENTIALS_JSON)',
    }
  }

  const credentials = loadServiceAccountCredentials()
  if (!credentials?.client_email || !credentials?.private_key) {
    return {
      configured: false,
      ok: false,
      status: 'unavailable',
      error: 'Invalid Play Integrity service account JSON',
    }
  }

  try {
    const accessToken = await getGoogleAccessToken(credentials)
    const url = `https://playintegrity.googleapis.com/v1/${encodeURIComponent(packageName)}:decodeIntegrityToken`
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ integrityToken: token }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      return {
        configured: true,
        ok: false,
        status: 'failed',
        error: text(body.error?.message || body.error || res.statusText, 500),
      }
    }

    const verdict = sanitizeVerdictPayload(body, packageName)
    const evaluation = evaluateIntegrityVerdict(verdict, expectedNonce)

    return {
      configured: true,
      ok: evaluation.passed,
      status: evaluation.status,
      verdict,
      reasons: evaluation.reasons,
    }
  } catch (e) {
    return {
      configured: true,
      ok: false,
      status: 'failed',
      error: String(e.message || e),
    }
  }
}

export function attestationRequiredForTrust() {
  return String(process.env.SECURITY_ATTESTATION_REQUIRED ?? '').trim().toLowerCase() === 'true'
}
