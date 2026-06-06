/**
 * Regression: chrome playerType + legacy types + authorizedPackageName on channels API.
 * Usage: node server/scripts/verify-channels-chrome-regression.mjs [baseUrl] [adminToken]
 */
import { normalizePlayerType } from '../src/channelNormalize.js'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const base = (process.argv[2] || 'https://osmani-admin-api.onrender.com').replace(/\/$/, '')
const adminToken = process.argv[3] || process.env.ADMIN_API_TOKEN || ''

const health = await fetch(`${base}/api/health`).then((r) => r.json())
console.log('health.commit:', health.commit)

const legacyTypes = ['exo', 'webview']
const channels = await fetch(`${base}/api/channels`).then((r) => {
  if (!r.ok) throw new Error(`channels HTTP ${r.status}`)
  return r.json()
})

console.log('channels.count:', channels.length)

const byType = {}
for (const ch of channels) {
  const pt = String(ch.playerType ?? '').toLowerCase()
  byType[pt] = (byType[pt] || 0) + 1
  assert('authorizedPackageName' in ch, `missing authorizedPackageName on ${ch.id}`)
  assert(ch.authorizedPackageName === ch.authorized_package_name, `mpingo mismatch ${ch.id}`)
  assert(normalizePlayerType(pt) === pt || pt === '', `invalid stored type ${pt} on ${ch.id}`)
}

console.log('playerType distribution:', byType)

for (const t of legacyTypes) {
  const n = byType[t] || 0
  assert(n > 0, `expected existing ${t} channels`)
  console.log(`OK legacy ${t}: ${n} channel(s)`)
}

const sample = channels.find((c) => c.playerType === 'exo') || channels[0]
assert(sample?.playerType, 'sample channel')
assert(sample.url, 'sample has url')
console.log('sample channel:', { id: sample.id, name: sample.name, playerType: sample.playerType })

if (adminToken) {
  const target = channels.find((c) => String(c.playerType).toLowerCase() === 'exo') || channels[0]
  const prevType = target.playerType
  const putBody = {
    name: target.name,
    url: target.url,
    category: target.category,
    bottomTab: target.bottomTab,
    playerType: 'chrome',
    accessType: target.accessType,
    isLive: target.isLive,
    isHD: target.isHD,
    isActive: target.isActive,
    showInApp: target.showInApp,
    authorizedPackageName: target.authorizedPackageName || '',
  }
  const putRes = await fetch(`${base}/api/channels/${target.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
    body: JSON.stringify(putBody),
  })
  const putJson = await putRes.json().catch(() => ({}))
  assert(putRes.ok, `PUT chrome failed: ${putRes.status} ${JSON.stringify(putJson)}`)
  assert(putJson.playerType === 'chrome', `PUT response playerType ${putJson.playerType}`)
  const reread = await fetch(`${base}/api/channels`).then((r) => r.json())
  const saved = reread.find((c) => c.id === target.id)
  assert(saved?.playerType === 'chrome', 'GET after PUT playerType chrome')
  await fetch(`${base}/api/channels/${target.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'X-Admin-Token': adminToken },
    body: JSON.stringify({ ...putBody, playerType: prevType }),
  })
  console.log(`OK chrome save round-trip on channel ${target.id}, restored ${prevType}`)
}

console.log('Regression passed.')
