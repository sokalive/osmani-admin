#!/usr/bin/env node
/**
 * Trigger Render deploys for osmani-admin-api + osmani-admin-mpya via Render REST API.
 *
 * Requires: RENDER_API_KEY (https://dashboard.render.com/u/settings#api-keys)
 *
 * Usage:
 *   RENDER_API_KEY=rnd_... node deploy/render/trigger-render-deploy.mjs
 *   RENDER_API_KEY=rnd_... EXPECT_COMMIT=b2d7e12 node deploy/render/trigger-render-deploy.mjs
 */
const KEY = String(process.env.RENDER_API_KEY || '').trim()
const EXPECT_COMMIT = String(process.env.EXPECT_COMMIT || 'b2d7e12').trim()
const SERVICES = ['osmani-admin-api', 'osmani-admin-mpya']

async function renderFetch(path, opts = {}) {
  const res = await fetch(`https://api.render.com/v1${path}`, {
    ...opts,
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${KEY}`,
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
      ...opts.headers,
    },
  })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} → ${res.status}: ${JSON.stringify(json).slice(0, 300)}`)
  return json
}

function unwrap(row) {
  return row?.service || row?.deploy || row
}

async function listServices() {
  const out = []
  let cursor = ''
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ limit: '100' })
    if (cursor) q.set('cursor', cursor)
    const page = await renderFetch(`/services?${q}`)
    const rows = Array.isArray(page) ? page : []
    out.push(...rows)
    cursor = page?.cursor || ''
    if (!cursor) break
  }
  return out.map((r) => {
    const s = unwrap(r)
    return { id: s?.id, name: s?.name, type: s?.type, branch: s?.branch, autoDeploy: s?.autoDeploy }
  })
}

async function triggerDeploy(serviceId, commitId) {
  const body = commitId ? { commitId } : {}
  const res = await renderFetch(`/services/${serviceId}/deploys`, {
    method: 'POST',
    body: JSON.stringify(body),
  })
  return unwrap(res)
}

async function pollDeploy(serviceId, deployId, maxMs = 900_000) {
  const t0 = Date.now()
  while (Date.now() - t0 < maxMs) {
    const d = unwrap(await renderFetch(`/services/${serviceId}/deploys/${deployId}`))
    const status = String(d?.status || '').toLowerCase()
    process.stdout.write(`  deploy ${deployId.slice(0, 8)}… ${status}\n`)
    if (status === 'live') return d
    if (status === 'build_failed' || status === 'update_failed' || status === 'canceled') {
      throw new Error(`Deploy ${deployId} failed: ${status}`)
    }
    await new Promise((r) => setTimeout(r, 15_000))
  }
  throw new Error(`Deploy ${deployId} timed out`)
}

async function waitForCommit(baseUrl, expectPrefix) {
  const t0 = Date.now()
  while (Date.now() - t0 < 900_000) {
    try {
      const res = await fetch(`${baseUrl}/api/health`, { cache: 'no-store' })
      const j = await res.json()
      const c = String(j.commit || '')
      console.log(`  ${baseUrl} commit=${c.slice(0, 7)}`)
      if (c.startsWith(expectPrefix)) return c
    } catch (e) {
      console.log(`  ${baseUrl} health error: ${e.message}`)
    }
    await new Promise((r) => setTimeout(r, 15_000))
  }
  throw new Error(`${baseUrl} did not reach commit ${expectPrefix}`)
}

async function main() {
  if (!KEY) {
    console.error('FATAL: RENDER_API_KEY is not set.')
    console.error('Get a key: https://dashboard.render.com/u/settings#api-keys')
    console.error('Then: RENDER_API_KEY=rnd_... node deploy/render/trigger-render-deploy.mjs')
    process.exit(1)
  }

  console.log('=== Trigger Render deploys ===')
  console.log('Target commit:', EXPECT_COMMIT)

  const all = await listServices()
  const targets = SERVICES.map((name) => {
    const s = all.find((x) => x.name === name)
    if (!s?.id) throw new Error(`Service not found: ${name}`)
    return s
  })

  for (const s of targets) {
    console.log(`\n→ ${s.name} (${s.id}) branch=${s.branch} autoDeploy=${s.autoDeploy}`)
    const deploy = await triggerDeploy(s.id, EXPECT_COMMIT)
    console.log(`  started deploy ${deploy?.id} status=${deploy?.status}`)
    await pollDeploy(s.id, deploy.id)
  }

  console.log('\n=== Verify production commits ===')
  await waitForCommit('https://osmani-admin-api.onrender.com', EXPECT_COMMIT)

  const mpyaHome = await fetch('https://osmani-admin-mpya.onrender.com/').then((r) => r.text())
  const bundle = mpyaHome.match(/src="(\/assets\/[^"]+\.js)"/)?.[1]
  console.log('Render admin bundle:', bundle || '(unknown)')

  console.log('\nDone.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
