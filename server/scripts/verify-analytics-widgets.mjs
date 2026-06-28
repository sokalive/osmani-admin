/**
 * End-to-end verification: Most Watched + Top 5 dashboard widgets.
 *
 * Usage:
 *   node scripts/verify-analytics-widgets.mjs
 *   VPS_API=https://api.osmanitv.com node scripts/verify-analytics-widgets.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseChannelIdFromPayload, TOP5_MIN_VIEWERS } from '../src/lib/analyticsPresence.js'

const BASE = String(process.env.VPS_API || 'https://api.osmanitv.com').replace(/\/+$/, '')
const RENDER_API = String(process.env.RENDER_API || 'https://osmani-admin-api.onrender.com').replace(
  /\/+$/,
  '',
)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPORT_DIR = path.resolve(__dirname, '../../docs/analytics-widget-verification')
const REPORT_HTML = path.join(REPORT_DIR, 'report.html')

const PREFIX = `widget_verify_${Date.now()}_`

let failed = 0
const evidence = { before: null, afterMostWatched: null, afterTop5: null, steps: [] }

function fail(msg) {
  console.error(`FAIL ${msg}`)
  failed += 1
}

function pass(msg) {
  console.log(`OK ${msg}`)
}

async function fetchJson(url, opts = {}) {
  const res = await fetch(url, { cache: 'no-store', ...opts })
  const body = await res.json().catch(() => ({}))
  return { status: res.status, body, ok: res.ok }
}

async function snapshot() {
  const { body } = await fetchJson(`${BASE}/api/analytics/snapshot`)
  return body
}

async function heartbeat(route, payload, apiBase = BASE) {
  const { status, body } = await fetchJson(`${apiBase}${route}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  return { status, body, route }
}

async function sessionEnd(deviceId, apiBase = BASE) {
  await fetchJson(`${BASE}/api/analytics/session/end`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ device_id: deviceId }),
  })
}

function renderWidgetHtml(title, rows, emptyMsg) {
  const sorted = [...rows].sort((a, b) => b.viewers - a.viewers)
  const items =
    sorted.length === 0
      ? `<p class="empty">${emptyMsg}</p>`
      : sorted
          .map(
            (r) =>
              `<li><span class="name">${r.name || r.channel_id}</span><span class="pill">${r.viewers} live</span></li>`,
          )
          .join('')
  return `<section class="widget"><h2>${title}</h2><ul>${items}</ul></section>`
}

function buildReportHtml() {
  const before = evidence.before || {}
  const afterMw = evidence.afterMostWatched || {}
  const afterT5 = evidence.afterTop5 || {}
  const mwBefore = (before.mostWatched || []).map((r) => ({
    channel_id: r.channel_id,
    viewers: r.viewers,
    name: `Channel ${r.channel_id}`,
  }))
  const t5Before = (before.top5 || []).map((r) => ({
    channel_id: r.channel_id,
    viewers: r.viewers,
    name: `Channel ${r.channel_id}`,
  }))
  const mwAfter = (afterMw.mostWatched || []).map((r) => ({
    channel_id: r.channel_id,
    viewers: r.viewers,
    name: `Channel ${r.channel_id}`,
  }))
  const t5After = (afterT5.top5 || []).map((r) => ({
    channel_id: r.channel_id,
    viewers: r.viewers,
    name: `Channel ${r.channel_id}`,
  }))

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Analytics Widget Verification</title>
  <style>
    body { font-family: Inter, system-ui, sans-serif; background: #0b0f1a; color: #e2e8f0; margin: 0; padding: 24px; }
    h1 { font-size: 1.5rem; margin: 0 0 8px; }
    .meta { color: #94a3b8; font-size: 0.85rem; margin-bottom: 24px; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    .panel { background: #0f172a; border: 1px solid #334155; border-radius: 16px; padding: 16px; }
    .panel h3 { margin: 0 0 12px; color: #fbbf24; font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em; }
    .widgets { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .widget { background: linear-gradient(180deg, #0f172a, #020617); border: 1px solid #475569; border-radius: 12px; padding: 12px; min-height: 160px; }
    .widget h2 { margin: 0 0 10px; font-size: 0.95rem; }
    .widget ul { list-style: none; margin: 0; padding: 0; }
    .widget li { display: flex; justify-content: space-between; gap: 8px; padding: 6px 0; border-bottom: 1px solid #1e293b; font-size: 0.85rem; }
    .pill { background: #7f1d1d; color: #fecaca; border-radius: 999px; padding: 2px 8px; font-size: 0.75rem; white-space: nowrap; }
    .empty { color: #64748b; font-size: 0.85rem; margin: 0; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; margin-top: 24px; }
    th, td { border: 1px solid #334155; padding: 8px; text-align: left; }
    th { background: #1e293b; }
    .ok { color: #86efac; }
    .fail { color: #fca5a5; }
  </style>
</head>
<body>
  <h1>Most Watched &amp; Top 5 — Before / After</h1>
  <p class="meta">API: ${BASE} · Top 5 min viewers: ${TOP5_MIN_VIEWERS} · Generated ${new Date().toISOString()}</p>
  <div class="grid">
    <div class="panel">
      <h3>Before (production baseline)</h3>
      <p class="meta">onlineNow: ${before.onlineNow ?? '—'}</p>
      <div class="widgets">
        ${renderWidgetHtml('Most Watched Channels', mwBefore, 'No active viewers')}
        ${renderWidgetHtml('Top 5 Channels (≥10)', t5Before, 'No channel has 10+ viewers')}
      </div>
    </div>
    <div class="panel">
      <h3>After (synthetic E2E probes)</h3>
      <p class="meta">onlineNow: ${afterMw.onlineNow ?? '—'}</p>
      <div class="widgets">
        ${renderWidgetHtml('Most Watched Channels', mwAfter, 'No active viewers')}
        ${renderWidgetHtml('Top 5 Channels (≥10)', t5After, 'No channel has 10+ viewers')}
      </div>
    </div>
  </div>
  <table>
    <thead><tr><th>Step</th><th>Result</th><th>Detail</th></tr></thead>
    <tbody>
      ${evidence.steps
        .map(
          (s) =>
            `<tr><td>${s.step}</td><td class="${s.ok ? 'ok' : 'fail'}">${s.ok ? 'PASS' : 'FAIL'}</td><td>${s.detail}</td></tr>`,
        )
        .join('')}
    </tbody>
  </table>
</body>
</html>`
}

async function main() {
  console.log(`=== Analytics widget E2E (${BASE}) ===`)

  evidence.before = await snapshot()
  pass(`baseline onlineNow=${evidence.before.onlineNow} mostWatched=${evidence.before.mostWatched?.length ?? 0} top5=${evidence.before.top5?.length ?? 0}`)

  // Unit: nested channel object (legacy JSON shapes)
  const nested = parseChannelIdFromPayload({ channel: { id: '7' } })
  if (nested === '7') pass('parseChannelId nested channel.id')
  else fail(`parseChannelId nested: got ${nested}`)

  const routes = [
    '/api/analytics/session/heartbeat',
    '/api/analytics/session/ping',
    '/api/analytics/live/ping',
    '/api/live/ping',
    '/api/session/ping',
  ]

  const probeDevice = `${PREFIX}single`
  for (const route of routes) {
    const { status } = await heartbeat(route, {
      device_id: probeDevice,
      channel_id: '88',
      country: 'TZ',
    })
    const ok = status === 200
    evidence.steps.push({ step: `POST ${route}`, ok, detail: `HTTP ${status}` })
    if (ok) pass(`${route} => 200`)
    else fail(`${route} => ${status} (legacy apps need 200)`)
  }

  const snapSingle = await snapshot()
  const ch88 = snapSingle.mostWatched?.find((x) => String(x.channel_id) === '88')
  if (ch88 && ch88.viewers >= 1) {
    pass('mostWatched includes channel 88 after heartbeat')
    evidence.steps.push({ step: 'mostWatched immediate', ok: true, detail: 'channel 88 visible' })
  } else {
    fail('mostWatched missing channel 88 after heartbeat')
    evidence.steps.push({ step: 'mostWatched immediate', ok: false, detail: JSON.stringify(snapSingle.mostWatched) })
  }

  // Multi-version cohort: v15-style nested channel + v24 flat id
  const v15Device = `${PREFIX}v15`
  const v24Device = `${PREFIX}v24`
  await heartbeat('/api/analytics/session/heartbeat', {
    device_id: v15Device,
    channel: { id: '55' },
    country: 'TZ',
  })
  await heartbeat('/api/analytics/session/heartbeat', {
    device_id: v24Device,
    channel_id: '55',
    country: 'TZ',
  })

  const snapMulti = await snapshot()
  const ch55 = snapMulti.mostWatched?.find((x) => String(x.channel_id) === '55')
  if (ch55 && ch55.viewers >= 2) {
    pass('mostWatched aggregates v15 nested + v24 flat (channel 55 viewers>=2)')
    evidence.steps.push({ step: 'all versions aggregate', ok: true, detail: `viewers=${ch55.viewers}` })
  } else {
    fail(`mostWatched channel 55 viewers=${ch55?.viewers ?? 0}, want >=2`)
    evidence.steps.push({ step: 'all versions aggregate', ok: false, detail: JSON.stringify(ch55) })
  }

  // Top 5 threshold: 10 devices on channel 77
  const top5Channel = '77'
  const top5Devices = []
  for (let i = 0; i < TOP5_MIN_VIEWERS; i++) {
    const d = `${PREFIX}top5_${i}`
    top5Devices.push(d)
    await heartbeat('/api/analytics/session/heartbeat', {
      device_id: d,
      channel_id: top5Channel,
      country: 'TZ',
    })
  }

  const snapTop5 = await snapshot()
  evidence.afterMostWatched = snapTop5
  evidence.afterTop5 = snapTop5

  const ch77mw = snapTop5.mostWatched?.find((x) => String(x.channel_id) === top5Channel)
  const ch77t5 = snapTop5.top5?.find((x) => String(x.channel_id) === top5Channel)

  if (ch77mw && ch77mw.viewers >= TOP5_MIN_VIEWERS) {
    pass(`mostWatched channel ${top5Channel} viewers=${ch77mw.viewers}`)
  } else {
    fail(`mostWatched channel ${top5Channel} viewers=${ch77mw?.viewers ?? 0}`)
  }

  if (ch77t5 && ch77t5.viewers >= TOP5_MIN_VIEWERS) {
    pass(`top5 includes channel ${top5Channel} with ${ch77t5.viewers} viewers (threshold ${TOP5_MIN_VIEWERS})`)
    evidence.steps.push({ step: 'top5 threshold', ok: true, detail: `${ch77t5.viewers} viewers` })
  } else {
    fail(`top5 missing channel ${top5Channel} (threshold ${TOP5_MIN_VIEWERS})`)
    evidence.steps.push({ step: 'top5 threshold', ok: false, detail: JSON.stringify(snapTop5.top5) })
  }

  // Below threshold should NOT appear in top5
  const lowDevice = `${PREFIX}low`
  await heartbeat('/api/analytics/session/heartbeat', {
    device_id: lowDevice,
    channel_id: '66',
    country: 'TZ',
  })
  const snapLow = await snapshot()
  const ch66t5 = snapLow.top5?.find((x) => String(x.channel_id) === '66')
  const ch66mw = snapLow.mostWatched?.find((x) => String(x.channel_id) === '66')
  if (ch66mw && ch66mw.viewers === 1 && !ch66t5) {
    pass('channel with 1 viewer in mostWatched but excluded from top5')
    evidence.steps.push({ step: 'top5 excludes <10', ok: true, detail: 'channel 66 in MW only' })
  } else {
    fail(`top5 exclusion check: mw=${JSON.stringify(ch66mw)} top5=${JSON.stringify(ch66t5)}`)
    evidence.steps.push({ step: 'top5 excludes <10', ok: false, detail: 'unexpected top5 membership' })
  }

  // Combined Render (v16–v23) + VPS (v24): 5 devices each on channel 99
  const comboChannel = '99'
  const comboDevices = []
  for (let i = 0; i < 5; i++) {
    const renderDev = `${PREFIX}render_combo_${i}`
    const vpsDev = `${PREFIX}vps_combo_${i}`
    comboDevices.push(renderDev, vpsDev)
    const r1 = await heartbeat(
      '/api/analytics/session/heartbeat',
      { device_id: renderDev, channel_id: comboChannel, country: 'TZ' },
      RENDER_API,
    )
    const r2 = await heartbeat(
      '/api/analytics/session/heartbeat',
      { device_id: vpsDev, channel_id: comboChannel, country: 'TZ' },
      BASE,
    )
    if (r1.status !== 200 || r2.status !== 200) {
      fail(`combined host heartbeat render=${r1.status} vps=${r2.status}`)
    }
  }
  const snapCombo = await snapshot()
  const ch99 = snapCombo.mostWatched?.find((x) => String(x.channel_id) === comboChannel)
  if (ch99 && ch99.viewers >= 10) {
    pass(`combined Render+VPS channel ${comboChannel} viewers=${ch99.viewers}`)
    evidence.steps.push({
      step: 'Render+VPS combined aggregate',
      ok: true,
      detail: `viewers=${ch99.viewers}`,
    })
  } else {
    fail(`combined channel ${comboChannel} viewers=${ch99?.viewers ?? 0}, want >=10`)
    evidence.steps.push({
      step: 'Render+VPS combined aggregate',
      ok: false,
      detail: JSON.stringify(ch99),
    })
  }

  // channel_name-only payload (v24 presence style)
  const nameProbe = `${PREFIX}name_only`
  const channelsRes = await fetchJson(`${BASE}/api/channels`)
  const sampleChannel = Array.isArray(channelsRes.body)
    ? channelsRes.body.find((c) => c?.id != null && c?.name)
    : null
  if (sampleChannel) {
    await heartbeat('/api/analytics/presence/heartbeat', {
      device_id: nameProbe,
      channel_name: String(sampleChannel.name),
      country: 'TZ',
    })
    const snapName = await snapshot()
    const chNamed = snapName.mostWatched?.find(
      (x) => String(x.channel_id) === String(sampleChannel.id),
    )
    if (chNamed && chNamed.viewers >= 1) {
      pass(`channel_name resolves to id ${sampleChannel.id}`)
      evidence.steps.push({
        step: 'channel_name resolution',
        ok: true,
        detail: String(sampleChannel.name),
      })
    } else {
      fail(`channel_name not counted for id ${sampleChannel.id}`)
      evidence.steps.push({ step: 'channel_name resolution', ok: false, detail: 'missing' })
    }
    comboDevices.push(nameProbe)
  } else {
    fail('could not load channels for channel_name test')
  }

  const locSum = (snapCombo.locations || []).reduce((a, r) => a + (Number(r.users) || 0), 0)
  const mwSum = (snapCombo.mostWatched || []).reduce((a, r) => a + (Number(r.viewers) || 0), 0)
  const watchingNow = Number(snapCombo.watchingNow) || 0
  const idleNow = Number(snapCombo.idleNow) || 0
  const onlineNow = Number(snapCombo.onlineNow) || 0

  if (watchingNow === mwSum) {
    pass(`watchingNow matches mostWatched sum (${watchingNow})`)
    evidence.steps.push({
      step: 'watchingNow vs mostWatched',
      ok: true,
      detail: `watching=${watchingNow} mwSum=${mwSum}`,
    })
  } else {
    fail(`watchingNow ${watchingNow} != mostWatched sum ${mwSum}`)
    evidence.steps.push({
      step: 'watchingNow vs mostWatched',
      ok: false,
      detail: `watching=${watchingNow} mwSum=${mwSum}`,
    })
  }

  if (onlineNow === watchingNow + idleNow) {
    pass(`onlineNow split consistent (${onlineNow} = ${watchingNow} + ${idleNow})`)
    evidence.steps.push({
      step: 'onlineNow watching+idle',
      ok: true,
      detail: `online=${onlineNow} watching=${watchingNow} idle=${idleNow}`,
    })
  } else {
    fail(`onlineNow ${onlineNow} != watching ${watchingNow} + idle ${idleNow}`)
    evidence.steps.push({
      step: 'onlineNow watching+idle',
      ok: false,
      detail: `online=${onlineNow} watching=${watchingNow} idle=${idleNow}`,
    })
  }

  if (mwSum <= locSum) {
    pass(`watching tally consistent (mostWatched sum ${mwSum} <= locations sum ${locSum})`)
    evidence.steps.push({
      step: 'locations vs mostWatched consistency',
      ok: true,
      detail: `mw=${mwSum} loc=${locSum}`,
    })
  } else {
    fail(`mostWatched sum ${mwSum} exceeds locations sum ${locSum}`)
    evidence.steps.push({
      step: 'locations vs mostWatched consistency',
      ok: false,
      detail: `mw=${mwSum} loc=${locSum}`,
    })
  }

  // Cleanup probe devices
  const cleanupIds = [
    probeDevice,
    v15Device,
    v24Device,
    lowDevice,
    ...top5Devices,
    ...comboDevices,
  ]
  for (const id of cleanupIds) {
    await sessionEnd(id, BASE)
    await sessionEnd(id, RENDER_API).catch(() => {})
  }

  fs.mkdirSync(REPORT_DIR, { recursive: true })
  fs.writeFileSync(REPORT_HTML, buildReportHtml(), 'utf8')
  pass(`report written: ${REPORT_HTML}`)

  if (failed > 0) {
    console.error(`\n${failed} check(s) failed`)
    process.exit(1)
  }
  console.log('\nAll analytics widget checks passed.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
