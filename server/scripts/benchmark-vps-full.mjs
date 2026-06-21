/**
 * Full VPS benchmark — sequential warm + concurrent burst targets.
 *
 * Usage:
 *   node scripts/benchmark-vps-full.mjs
 *   VPS_API=https://api.osmanitv.com PAID_DEVICE_ID=abc123 node scripts/benchmark-vps-full.mjs
 */
const VPS = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
let PAID_DEVICE_ID = String(process.env.PAID_DEVICE_ID || '').trim()
const TARGET_MS = 2000

async function timed(path, opts = {}) {
  const t0 = performance.now()
  const res = await fetch(`${VPS}${path}`, { cache: 'no-store', ...opts })
  const text = await res.text()
  const ms = Math.round(performance.now() - t0)
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = null
  }
  return { status: res.status, ms, json, ok: res.ok }
}

async function burst(label, n, path, opts = {}) {
  const t0 = performance.now()
  const results = await Promise.all(
    Array.from({ length: n }, (_, i) =>
      fetch(`${VPS}${path}`, { cache: 'no-store', ...opts })
        .then(async (r) => ({ status: r.status, i }))
        .catch((e) => ({ status: 0, i, err: String(e.message || e) })),
    ),
  )
  const elapsed = Math.round(performance.now() - t0)
  const ok = results.filter((r) => r.status === 200).length
  const err5 = results.filter((r) => r.status >= 500).length
  const statuses = results.reduce((a, r) => {
    a[r.status] = (a[r.status] || 0) + 1
    return a
  }, {})
  const pass = ok === n && err5 === 0
  console.log(
    `${pass ? 'PASS' : 'FAIL'} ${label}: ${ok}/${n} OK, ${err5} x5xx, ${elapsed}ms`,
    statuses,
  )
  return { label, n, ok, err5, elapsed, pass, statuses }
}

async function sequentialPass(label) {
  console.log(`\n=== Sequential ${label} ===`)
  const rows = []
  const health = await timed('/api/health')
  rows.push({ endpoint: 'GET /api/health', ...health, note: health.json?.commit?.slice(0, 12) })

  for (const v of [16, 20, 23, 24]) {
    const r = await timed(`/api/update-check?version_code=${v}`)
    rows.push({
      endpoint: `GET /api/update-check v${v}`,
      ...r,
      note: r.json?.decision || r.json?.error || '-',
    })
  }

  const probe = `seq_${label}_${Date.now()}`
  const statusInactive = await timed(`/api/subscription-status?device_id=${probe}`)
  rows.push({
    endpoint: 'GET /api/subscription-status inactive',
    ...statusInactive,
    note: `active=${statusInactive.json?.active}`,
  })

  const verifyInactive = await timed('/api/subscription/verify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: `${probe}_v`, version_code: 20 }),
  })
  rows.push({
    endpoint: 'POST /api/subscription/verify inactive',
    ...verifyInactive,
    note: `active=${verifyInactive.json?.active} plans=${verifyInactive.json?.plans?.length ?? 0}`,
  })

  if (PAID_DEVICE_ID) {
    const statusPaid = await timed(`/api/subscription-status?device_id=${encodeURIComponent(PAID_DEVICE_ID)}`)
    rows.push({
      endpoint: 'GET /api/subscription-status paid',
      ...statusPaid,
      note: `active=${statusPaid.json?.active}`,
    })
    const verifyPaid = await timed('/api/subscription/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: PAID_DEVICE_ID, version_code: 24 }),
    })
    rows.push({
      endpoint: 'POST /api/subscription/verify paid',
      ...verifyPaid,
      note: `active=${verifyPaid.json?.active}`,
    })
  } else {
    console.log('SKIP paid verify/status — set PAID_DEVICE_ID env for paid sequential probes')
  }

  let errors = 0
  let slow = 0
  for (const r of rows) {
    const flag = r.status >= 500 ? 'FAIL' : r.ms > TARGET_MS ? 'SLOW' : 'OK'
    if (r.status >= 500) errors += 1
    if (r.ms > TARGET_MS && r.status < 500) slow += 1
    console.log(`${flag} ${r.endpoint}: ${r.ms}ms HTTP ${r.status} ${r.note || ''}`)
  }
  return { rows, errors, slow, pass: errors === 0 && slow === 0 }
}

async function main() {
  console.log(`VPS full benchmark → ${VPS}`)
  const dbHealth = await timed('/api/health/db')
  if (dbHealth.ok) {
    console.log('DB stats:', JSON.stringify(dbHealth.json?.pg || {}, null, 0))
    if (!PAID_DEVICE_ID && dbHealth.json?.sample_active_device_id) {
      PAID_DEVICE_ID = String(dbHealth.json.sample_active_device_id).trim()
      console.log('Using sample_active_device_id from /api/health/db for paid probes')
    }
  }

  const warm1 = await sequentialPass('warm-pass-1')
  const warm2 = await sequentialPass('warm-pass-2')

  console.log('\n=== Concurrent burst ===')
  const bursts = []
  bursts.push(await burst('50x update-check v24', 50, '/api/update-check?version_code=24'))
  bursts.push(
    await burst('50x verify inactive', 50, '/api/subscription/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        device_id: `burst50_${Date.now()}`,
        version_code: 24,
      }),
    }),
  )
  // Unique device per request — worst case inactive load
  bursts.push(
    await burst('100x update-check v24', 100, '/api/update-check?version_code=24'),
  )
  {
    const t0 = performance.now()
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        fetch(`${VPS}/api/subscription/verify`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            device_id: `burst100_inactive_${Date.now()}_${i}`,
            version_code: 24,
          }),
          cache: 'no-store',
        })
          .then((r) => ({ status: r.status }))
          .catch(() => ({ status: 0 })),
      ),
    )
    const elapsed = Math.round(performance.now() - t0)
    const ok = results.filter((r) => r.status === 200).length
    const err5 = results.filter((r) => r.status >= 500).length
    const pass = ok === 100 && err5 === 0
    console.log(
      `${pass ? 'PASS' : 'FAIL'} 100x verify inactive (unique devices): ${ok}/100 OK, ${err5} x5xx, ${elapsed}ms`,
    )
    bursts.push({ label: '100x verify inactive unique', n: 100, ok, err5, pass })
  }

  if (PAID_DEVICE_ID) {
    bursts.push(
      await burst('100x verify paid (same device)', 100, '/api/subscription/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_id: PAID_DEVICE_ID, version_code: 24 }),
      }),
    )
  } else {
    console.log('SKIP 100x paid verify — set PAID_DEVICE_ID')
  }

  const dbAfter = await timed('/api/health/db')
  if (dbAfter.ok) {
    console.log('\nDB stats after burst:', JSON.stringify(dbAfter.json?.pg || {}, null, 0))
  }

  const seqPass = warm2.pass
  const burstPass = bursts.every((b) => b.pass)
  console.log('\n=== Summary ===')
  console.log(`sequential warm pass 2: ${seqPass ? 'PASS' : 'FAIL'}`)
  console.log(`concurrent bursts: ${burstPass ? 'PASS' : 'FAIL'}`)
  if (!seqPass || !burstPass) process.exit(1)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
