/**
 * Controlled Contabo pool saturation + recovery test (no real payments).
 *
 * Usage:
 *   node server/scripts/pool-saturation-recovery-test.mjs
 *   API_BASE=https://api.osmanitv.com CONCURRENCY=80 BURST_SEC=25 node server/scripts/pool-saturation-recovery-test.mjs
 */
const API = String(process.env.API_BASE || 'https://api.osmanitv.com').replace(/\/$/, '')
const CONCURRENCY = Math.max(10, Math.min(200, Number(process.env.CONCURRENCY) || 60))
const BURST_SEC = Math.max(5, Math.min(120, Number(process.env.BURST_SEC) || 20))
const COOLDOWN_SEC = Math.max(10, Math.min(180, Number(process.env.COOLDOWN_SEC) || 45))

async function getJson(path, timeoutMs = 20_000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(`${API}${path}`, {
      signal: ac.signal,
      headers: { Accept: 'application/json', 'Cache-Control': 'no-store' },
    })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = { raw: text.slice(0, 200) }
    }
    return { ok: res.ok, status: res.status, ms: Date.now() - t0, body }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, body: { error: String(e?.message || e) } }
  } finally {
    clearTimeout(t)
  }
}

async function postVerify(timeoutMs = 20_000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  const t0 = Date.now()
  try {
    const res = await fetch(`${API}/api/subscription/verify`, {
      method: 'POST',
      signal: ac.signal,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        device_id: `pool-sat-test-${Math.random().toString(16).slice(2, 10)}`,
      }),
    })
    return { ok: res.ok || res.status === 400, status: res.status, ms: Date.now() - t0 }
  } catch (e) {
    return { ok: false, status: 0, ms: Date.now() - t0, error: String(e?.message || e) }
  } finally {
    clearTimeout(t)
  }
}

async function readPool() {
  const h = await getJson('/api/health', 15_000)
  return {
    healthOk: h.ok,
    commit: h.body?.commit,
    pool: h.body?.pool,
    ms: h.ms,
  }
}

function summarize(samples) {
  const waits = samples.map((s) => Number(s.pool?.waitingCount ?? 0))
  const idles = samples.map((s) => Number(s.pool?.idleCount ?? 0))
  return {
    peakWaiting: Math.max(0, ...waits),
    endWaiting: waits[waits.length - 1] ?? null,
    endIdle: idles[idles.length - 1] ?? null,
    samples: samples.length,
  }
}

async function burst(label) {
  console.log(`==> ${label}: concurrency=${CONCURRENCY} for ${BURST_SEC}s`)
  const end = Date.now() + BURST_SEC * 1000
  let launched = 0
  let ok = 0
  let fail = 0
  let status503 = 0
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (Date.now() < end) {
      launched += 1
      const pick = launched % 3
      const r =
        pick === 0
          ? await getJson('/api/plans', 12_000)
          : pick === 1
            ? await getJson('/api/payments/checkout-providers', 12_000)
            : await postVerify(12_000)
      if (r.status === 503) status503 += 1
      if (r.ok || r.status === 503) ok += 1
      else fail += 1
    }
  })
  const poolSamples = []
  const sampler = (async () => {
    while (Date.now() < end) {
      poolSamples.push(await readPool())
      await new Promise((r) => setTimeout(r, 2000))
    }
  })()
  await Promise.all([...workers, sampler])
  return { launched, ok, fail, status503, pool: summarize(poolSamples), last: poolSamples[poolSamples.length - 1] }
}

async function cooldown() {
  console.log(`==> cooldown ${COOLDOWN_SEC}s (no traffic; expect pool drain without PM2 restart)`)
  const samples = []
  const end = Date.now() + COOLDOWN_SEC * 1000
  while (Date.now() < end) {
    const s = await readPool()
    samples.push(s)
    console.log(
      `  t+${Math.round((COOLDOWN_SEC * 1000 - (end - Date.now())) / 1000)}s waiting=${s.pool?.waitingCount} idle=${s.pool?.idleCount} saturated=${s.pool?.saturated}`,
    )
    await new Promise((r) => setTimeout(r, 5000))
  }
  return summarize(samples)
}

async function main() {
  console.log('API', API)
  const before = await readPool()
  console.log('before', JSON.stringify(before))
  if ((before.pool?.waitingCount ?? 0) > 200) {
    console.warn('WARN: pool already heavily saturated before test; recovery will still be measured')
  }

  const load = await burst('controlled load')
  console.log('burst', JSON.stringify(load, null, 2))

  const after = await cooldown()
  console.log('cooldown', JSON.stringify(after, null, 2))

  const checkout = await getJson('/api/payments/checkout-providers', 15_000)
  const plans = await getJson('/api/plans', 15_000)
  const verify = await postVerify(15_000)
  const health = await readPool()

  const recovered =
    (health.pool?.waitingCount ?? 9999) <= 20 &&
    (health.pool?.idleCount ?? 0) > 0 &&
    checkout.ok &&
    String(checkout.body?.payment_provider || '') === 'sonicpesa' &&
    plans.ok &&
    verify.ok

  const report = {
    ok: recovered,
    before,
    load,
    cooldown: after,
    after: health,
    checkout: {
      ok: checkout.ok,
      ms: checkout.ms,
      payment_provider: checkout.body?.payment_provider,
      status: checkout.status,
    },
    plans: { ok: plans.ok, ms: plans.ms, status: plans.status },
    verify: { ok: verify.ok, ms: verify.ms, status: verify.status },
    criteria: {
      waiting_le_20: (health.pool?.waitingCount ?? 9999) <= 20,
      idle_gt_0: (health.pool?.idleCount ?? 0) > 0,
      sonicpesa: checkout.body?.payment_provider === 'sonicpesa',
      no_pm2_restart_required: true,
    },
  }
  console.log(JSON.stringify(report, null, 2))
  if (!recovered) process.exitCode = 1
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
