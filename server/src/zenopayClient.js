/**
 * Resolve live credentials: process.env overrides DB (production-friendly).
 */
export function resolveZenopayCredentials(row) {
  const r = row && typeof row === 'object' ? row : {}
  return {
    apiKey: String(process.env.ZENO_API_KEY || r.api_key || '').trim(),
    accountId: String(process.env.ZENO_ACCOUNT_ID || r.account_id || '').trim(),
    apiEndpoint: String(process.env.ZENO_ENDPOINT || r.api_endpoint || '').trim(),
  }
}

function summarizeProviderHttpError(res, text) {
  const ct = (res.headers.get('content-type') || '').toLowerCase()
  const body = String(text || '').trim()
  const looksHtml =
    ct.includes('text/html') ||
    body.startsWith('<!') ||
    body.toLowerCase().startsWith('<html')
  if (looksHtml) {
    const st = res.statusText ? ` ${res.statusText}`.trim() : ''
    return `HTTP ${res.status}${st ? ` (${st})` : ''}. The provider returned a non-JSON response (HTML or web page), not an API error body.`
  }
  const snippet = body.replace(/\s+/g, ' ').slice(0, 200)
  return snippet ? `HTTP ${res.status}: ${snippet}` : `HTTP ${res.status}`
}

/**
 * Config / connectivity check only — does not POST to collection or payment routes.
 * Probes the API host (HEAD, then GET on 405) so POST-only paths are never called.
 */
export async function testZenopayConnection(cred) {
  if (!cred.apiKey) {
    return { ok: false, message: 'Missing API key (configure in admin or .env).', httpStatus: 0 }
  }
  if (!cred.apiEndpoint) {
    return { ok: false, message: 'Missing API endpoint (configure in admin or .env).', httpStatus: 0 }
  }

  let probeUrl
  try {
    const parsed = new URL(String(cred.apiEndpoint).trim())
    if (!/^https?:$/i.test(parsed.protocol)) {
      return { ok: false, message: 'API endpoint must use http or https.', httpStatus: 0 }
    }
    const envProbe = String(process.env.ZENO_CONNECTIVITY_PROBE_URL || '').trim()
    probeUrl = envProbe || parsed.origin
  } catch {
    return {
      ok: false,
      message: 'Invalid API endpoint URL (use a full URL including https://).',
      httpStatus: 0,
    }
  }

  const headers = {
    Authorization: `Bearer ${cred.apiKey}`,
    ...(cred.accountId ? { 'X-Account-Id': cred.accountId } : {}),
    Accept: 'application/json, */*',
  }

  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 15_000)

  try {
    let res = await fetch(probeUrl, { method: 'HEAD', headers, signal: ac.signal })
    if (res.status === 405) {
      res = await fetch(probeUrl, { method: 'GET', headers, signal: ac.signal })
    }
    clearTimeout(t)
    const text = await res.text()

    if (res.status === 401) {
      return {
        ok: false,
        message: 'Authentication failed (HTTP 401). Check your API key.',
        httpStatus: res.status,
      }
    }
    if (res.status >= 500) {
      return { ok: false, message: summarizeProviderHttpError(res, text), httpStatus: res.status }
    }

    return {
      ok: true,
      message: `Connected (HTTP ${res.status}). API host is reachable and credentials are present.`,
      httpStatus: res.status,
    }
  } catch (e) {
    clearTimeout(t)
    const msg = e?.name === 'AbortError' ? 'Request timed out' : String(e.message || e)
    return { ok: false, message: msg, httpStatus: 0 }
  }
}

const COLLECT_SUFFIX = process.env.ZENO_COLLECT_PATH || '/collections'

/**
 * Initiate provider collection request. Body shape can be overridden via env-driven JSON template later.
 */
export async function zenopayCreateCollection(cred, { phone, amount, reference, currency = 'TZS' }) {
  const base = cred.apiEndpoint.replace(/\/$/, '')
  const path = COLLECT_SUFFIX.startsWith('/') ? COLLECT_SUFFIX : `/${COLLECT_SUFFIX}`
  const url = `${base}${path}`
  const body = {
    phone: String(phone).replace(/\s+/g, ''),
    amount: Number(amount),
    reference: String(reference),
    currency,
    account_id: cred.accountId || undefined,
  }
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cred.apiKey}`,
        ...(cred.accountId ? { 'X-Account-Id': cred.accountId } : {}),
      },
      body: JSON.stringify(body),
      signal: ac.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = { raw: text.slice(0, 2000) }
    }
    return { ok: res.ok, status: res.status, body: json }
  } catch (e) {
    clearTimeout(t)
    return { ok: false, status: 0, body: { error: String(e.message || e) } }
  }
}
