/**
 * Regression tests for notification destination + recurrence helpers.
 * Usage: node scripts/test-notifications-regression.mjs
 */
import {
  buildNotificationDestination,
  channelDeepLink,
  destinationFromPayloadAndTargetType,
  oneSignalDataFromDestination,
} from '../src/lib/notificationDestination.js'
import {
  computeNextScheduleAt,
  isRecurringKind,
  normalizeRecurrenceFields,
  normalizeRecurrenceInterval,
  recurrenceAdvanceFrom,
  recurrenceKindLabel,
} from '../src/lib/notificationRecurrence.js'
import { buildProductionOneSignalBody } from '../src/lib/oneSignalPush.js'

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

// Destination
const home = buildNotificationDestination({ destinationType: 'home' })
assert(home.type === 'home' && home.deepLink === 'osmani://home', 'home destination')

const ch = buildNotificationDestination({
  destinationType: 'channel',
  channelId: 42,
  channelName: 'Test TV',
})
assert(ch.deepLink === 'osmani://channel/42' && ch.channelName === 'Test TV', 'channel destination')

const custom = buildNotificationDestination({
  destinationType: 'custom',
  customDeepLink: 'osmani://settings',
})
assert(custom.deepLink === 'osmani://settings', 'custom destination')

const derived = destinationFromPayloadAndTargetType({}, 'osmani://channel/7')
assert(derived.type === 'channel' && derived.channelId === 7, 'derive channel from target_type')

const osData = oneSignalDataFromDestination(ch)
assert(osData.channel_id === '42' && osData.destination_type === 'channel', 'onesignal data map')

// OneSignal body unchanged without data
const baseBody = buildProductionOneSignalBody({
  appId: 'app',
  title: 'T',
  message: 'M',
})
assert(baseBody.target_channel === 'push' && !baseBody.data && baseBody.included_segments[0] === 'Total Subscriptions', 'base push body')

const imgBody = buildProductionOneSignalBody({
  appId: 'app',
  title: 'T',
  message: 'M',
  imageUrl: 'https://api.osmanitv.com/uploads/notif-test.jpg',
})
assert(
  imgBody.big_picture?.includes('api.osmanitv.com') &&
    imgBody.chrome_web_image === imgBody.big_picture,
  'push image uses VPS origin + chrome_web_image',
)

// Recurrence
assert(!isRecurringKind('once') && isRecurringKind('daily'), 'recurring kind detection')

const rec = normalizeRecurrenceFields(
  { recurrenceKind: 'interval_minutes', recurrenceInterval: 15, scheduleAt: '2030-01-01T12:00:00.000Z', status: 'scheduled' },
  null,
  { status: 'scheduled' },
)
assert(rec.recurrenceKind === 'interval_minutes' && rec.recurrenceInterval === 15 && rec.isRecurrenceTemplate, 'interval recurrence')

let threw = false
try {
  normalizeRecurrenceFields({ recurrenceKind: 'daily', status: 'sent' }, null, { status: 'sent' })
} catch {
  threw = true
}
assert(threw, 'instant + recurring rejected')

const anchor = '2026-06-01T09:30:00.000Z'
const nextDaily = computeNextScheduleAt({
  from: anchor,
  kind: 'daily',
  interval: null,
  anchorAt: anchor,
})
assert(nextDaily && new Date(nextDaily).getDate() === 2, 'daily next schedule')

const lateFrom = recurrenceAdvanceFrom({
  kind: 'daily',
  scheduleAt: '2026-06-01T19:00:00.000Z',
  sentAtIso: '2026-06-02T22:00:00.000Z',
})
const lateNext = computeNextScheduleAt({
  from: lateFrom,
  kind: 'daily',
  interval: null,
  anchorAt: '2026-06-01T19:00:00.000Z',
})
assert(lateNext === '2026-06-02T19:00:00.000Z', 'daily late flush uses schedule_at basis')

const nextMin = computeNextScheduleAt({
  from: anchor,
  kind: 'interval_minutes',
  interval: 30,
  anchorAt: anchor,
})
assert(
  new Date(nextMin).getTime() - new Date(anchor).getTime() === 30 * 60_000,
  'interval minutes next schedule',
)

assert(recurrenceKindLabel('interval_hours', 2) === 'Every 2 hr', 'recurrence label')

assert(normalizeRecurrenceInterval('interval_minutes', 0) === 1, 'interval min clamp')

console.log(JSON.stringify({ passed, failed, ok: failed === 0 }, null, 2))
process.exit(failed > 0 ? 1 : 0)
