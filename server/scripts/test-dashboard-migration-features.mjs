/**
 * Location place grouping + channel playback gate unit tests.
 * Run: node server/scripts/test-dashboard-migration-features.mjs
 */
import {
  aggregateLocationsByPlace,
  isCountryNameOnlyPlace,
  normalizeLocationPayload,
  sumLocationsOnline,
  UNKNOWN_LOCATION,
} from '../src/lib/analyticsLocation.js'
import {
  applyChannelPlaybackGate,
  APP_UPDATE_NEVER_MIN,
} from '../src/lib/appUpdateTargeting.js'
import { classifyDeviceForTest } from '../src/lib/appVersionMigration.js'

let passed = 0
let failed = 0

function assert(cond, msg) {
  if (cond) {
    passed += 1
    return
  }
  failed += 1
  console.error('FAIL:', msg)
}

const rows = aggregateLocationsByPlace([
  { country: 'TZ • Moshi', users: 4 },
  { country: 'TZ • Kigoma', users: 3 },
  { country: 'KE • Mombasa', users: 2 },
  { country: 'Unknown', users: 1 },
])
assert(rows.length === 4, `expected 4 place rows got ${rows.length}`)
assert(rows.some((r) => r.placeName === 'Moshi' && r.users === 4), 'Moshi row')
assert(rows.some((r) => r.placeName === 'Kigoma' && r.users === 3), 'Kigoma row')
assert(rows.some((r) => r.placeName === 'Mombasa' && r.countryCode === 'KE'), 'Mombasa row')
assert(
  rows.some((r) => r.placeName === UNKNOWN_LOCATION && r.users === 1),
  'unknown location row',
)

const merged = aggregateLocationsByPlace([
  { country: 'TZ • Moshi', users: 2 },
  { country: 'TZ • Moshi', users: 2 },
])
assert(merged.length === 1 && merged[0].users === 4, 'merge same place')

const countryOnly = aggregateLocationsByPlace([{ country: 'TZ • Tanzania', users: 7 }])
assert(
  countryOnly.length === 1 &&
    countryOnly[0].placeName === UNKNOWN_LOCATION &&
    countryOnly[0].users === 7,
  'country-only label becomes Unknown Location',
)
assert(isCountryNameOnlyPlace('TZ', 'Tanzania'), 'detect country-only place')

const displayRows = aggregateLocationsByPlace([
  { country: 'TZ • Dar es Salaam', users: 1 },
  { country: 'FR • Paris', users: 2 },
])
assert(
  displayRows.some((r) => r.location === 'TZ — Dar es Salaam' && r.users === 1),
  'TZ — Dar es Salaam display',
)
assert(
  displayRows.some((r) => r.location === 'FR — Paris' && r.users === 2),
  'FR — Paris display',
)

const onlineRows = aggregateLocationsByPlace([
  { country: 'Unknown', users: 3 },
  { country: 'TZ • Dar es Salaam', users: 1 },
])
assert(sumLocationsOnline(onlineRows) === 4, 'locations sum equals online total')

const cityBeforeRegion = normalizeLocationPayload({
  country_code: 'TZ',
  city: 'Moshi',
  region: 'Kilimanjaro',
})
assert(cityBeforeRegion === 'TZ • Moshi', 'city preferred over region')

const regionOnly = normalizeLocationPayload({
  country_code: 'KE',
  region: 'Mombasa',
})
assert(regionOnly === 'KE • Mombasa', 'region used when city absent')

const legacyBlocked = applyChannelPlaybackGate(
  { requireUpdateBeforeChannelPlayback: true },
  20,
)
assert(
  legacyBlocked.require_update_before_channel_playback === true,
  'v20 channel gate active',
)
assert(legacyBlocked.channel_playback_block_title.includes('Huwezi'), 'swahili title')

const v24Clear = applyChannelPlaybackGate(
  { requireUpdateBeforeChannelPlayback: true },
  APP_UPDATE_NEVER_MIN,
)
assert(v24Clear.require_update_before_channel_playback === false, 'v24 not blocked')

const gateOff = applyChannelPlaybackGate(
  { requireUpdateBeforeChannelPlayback: false },
  18,
)
assert(gateOff.require_update_before_channel_playback === false, 'gate off')

assert(
  classifyDeviceForTest({ sawLegacy: true, sawV24: true }).status === 'updated_to_v24',
  'migrated',
)
assert(
  classifyDeviceForTest({ sawLegacy: true, sawV24: false }).status === 'legacy_not_updated',
  'not updated',
)
assert(
  classifyDeviceForTest({ sawLegacy: false, sawV24: true }).status === 'brand_new_v24',
  'brand new v24',
)

console.log(JSON.stringify({ passed, failed, ok: failed === 0 }, null, 2))
process.exit(failed > 0 ? 1 : 0)
