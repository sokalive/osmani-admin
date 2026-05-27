/**
 * Verify admin banner save payload matches mobile GET /api/banners contract.
 * Usage: node scripts/verify-banner-admin-payload.mjs [apiBaseUrl]
 */
import { bannerSaveBody } from '../../src/lib/bannerSaveBody.js'

const MOBILE_SPEC_KEYS = [
  'title',
  'description',
  'event_timer',
  'eventTimer',
  'useTimer',
  'redirectChannelId',
  'daily_start',
  'daily_end',
  'startTime',
  'endTime',
  'runtime_position',
  'runtimePosition',
]

function assertPayloadShape() {
  const body = bannerSaveBody({
    title: 'Test',
    description: 'Desc',
    useTimer: true,
    redirectChannelId: 11,
    startTime: '16:00',
    endTime: '20:00',
    runtimePosition: 'bottom_left',
    image: 'https://example.com/x.webp',
  })

  let failed = 0
  for (const key of MOBILE_SPEC_KEYS) {
    if (!(key in body)) {
      console.error(`FAIL bannerSaveBody missing key: ${key}`)
      failed += 1
    }
  }
  if (body.title !== 'Test') failed += 1
  if (body.description !== 'Desc') failed += 1
  if (body.event_timer !== true || body.useTimer !== true) failed += 1
  if (body.redirectChannelId !== 11) failed += 1
  if (body.daily_start !== '16:00' || body.daily_end !== '20:00') failed += 1
  if (body.runtime_position !== 'bottom_left') failed += 1

  if (failed > 0) {
    console.error('bannerSaveBody contract check failed', body)
    process.exit(1)
  }
  console.log('OK bannerSaveBody mobile spec fields:', MOBILE_SPEC_KEYS.join(', '))
  return body
}

async function assertPublicApi(base) {
  const res = await fetch(`${base.replace(/\/+$/, '')}/api/banners`, {
    headers: { Accept: 'application/json' },
  })
  const rows = await res.json().catch(() => [])
  if (!res.ok) throw new Error(`GET /api/banners ${res.status}`)
  const list = Array.isArray(rows) ? rows : rows?.value ?? []
  if (list.length === 0) {
    console.warn('WARN no banners on public API — skip field sampling')
    return
  }
  const sample = list[0]
  const publicKeys = [
    'title',
    'description',
    'event_timer',
    'redirect_channel_id',
    'daily_start',
    'daily_end',
    'runtime_position',
  ]
  let missing = 0
  for (const key of publicKeys) {
    if (!(key in sample)) {
      console.error(`FAIL public banner missing: ${key}`)
      missing += 1
    }
  }
  if (missing > 0) process.exit(1)
  console.log(`OK GET /api/banners sample id=${sample.id} has mobile fields`)
}

assertPayloadShape()
const base = process.argv[2] || process.env.API_BASE_URL || 'https://osmani-admin-api.onrender.com'
await assertPublicApi(base)
console.log('Banner admin payload verification passed.')
