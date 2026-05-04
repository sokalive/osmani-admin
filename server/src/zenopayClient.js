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

/**
 * Lightweight connectivity check (adjust ZENO_TEST_URL if your provider uses a different path).
 */
export async function testZenopayConnection(cred) {
  if (!cred.apiEndpoint || !cred.apiKey) {
    return { ok: false, message: 'Missing API endpoint or API key (configure in admin or .env).' }
  }
  const base = cred.apiEndpoint.replace(/\/$/, '')
  const url = (process.env.ZENO_TEST_URL || `${base}/health`).trim()
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 15_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${cred.apiKey}`,
        ...(cred.accountId ? { 'X-Account-Id': cred.accountId } : {}),
        Accept: 'application/json, */*',
      },
      signal: ac.signal,
    })
    clearTimeout(t)
    const text = await res.text()
    if (res.ok) {
      return { ok: true, message: `OK (${res.status})` }
    }
    return { ok: false, message: `HTTP ${res.status}: ${text.slice(0, 240)}` }
  } catch (e) {
    clearTimeout(t)
    const msg = e?.name === 'AbortError' ? 'Request timed out' : String(e.message || e)
    return { ok: false, message: msg }
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
