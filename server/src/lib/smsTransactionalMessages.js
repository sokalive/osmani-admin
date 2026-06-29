const EAT = 'Africa/Dar_es_Salaam'

const SWAHILI_PERIODS = {
  alfajiri: 'Alfajiri',
  asubuhi: 'Asubuhi',
  mchana: 'Mchana',
  alasiri: 'Alasiri',
  jioni: 'Jioni',
  usiku: 'Usiku',
}

function eatParts(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
  if (Number.isNaN(d.getTime())) return null
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: EAT,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)
  const get = (type) => parts.find((p) => p.type === type)?.value ?? ''
  return {
    day: get('day'),
    month: get('month'),
    year: get('year'),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
  }
}

function swahiliPeriod(hour, minute) {
  const mins = hour * 60 + minute
  if (mins >= 4 * 60 && mins < 6 * 60) return SWAHILI_PERIODS.alfajiri
  if (mins >= 6 * 60 && mins < 12 * 60) return SWAHILI_PERIODS.asubuhi
  if (mins >= 12 * 60 && mins < 15 * 60) return SWAHILI_PERIODS.mchana
  if (mins >= 15 * 60 && mins < 17 * 60) return SWAHILI_PERIODS.alasiri
  if (mins >= 17 * 60 && mins < 19 * 60) return SWAHILI_PERIODS.jioni
  return SWAHILI_PERIODS.usiku
}

function swahiliClock(hour, minute) {
  let sh
  let sm = minute
  if (hour >= 6 && hour < 18) {
    sh = hour === 6 ? 12 : hour - 6
  } else if (hour >= 18) {
    sh = hour === 18 ? 12 : hour - 18
  } else {
    sh = hour + 6
  }
  return { hour: sh, minute: sm }
}

function formatClockDigits(hour, minute) {
  return `${hour}:${String(minute).padStart(2, '0')}`
}

/**
 * Natural Swahili clock phrase — e.g. "Saa 6:23 Usiku" (not 24h "00:23").
 * Shared by all transactional SMS templates.
 */
export function formatSwahiliClockTime(dateInput) {
  const p = eatParts(dateInput)
  if (!p) return ''
  const period = swahiliPeriod(p.hour, p.minute)
  const clock = swahiliClock(p.hour, p.minute)
  return `Saa ${formatClockDigits(clock.hour, clock.minute)} ${period}`
}

export function formatTzPrice(amount, currency = 'TZS') {
  const n = Math.round(Number(amount))
  if (!Number.isFinite(n)) return `${currency} 0`
  return `${currency} ${n.toLocaleString('en-US')}`
}

/** Example: 04 Jul 2026 Saa 8:35 Mchana */
export function formatExpirySwahili(dateInput) {
  const p = eatParts(dateInput)
  if (!p) return ''
  const timePhrase = formatSwahiliClockTime(dateInput)
  return `${p.day} ${p.month} ${p.year} ${timePhrase}`
}

export function buildPaymentSuccessSms({ planName, price, currency, expiresAt }) {
  const pkg = String(planName ?? '').trim() || 'Kifurushi'
  const bei = formatTzPrice(price, currency || 'TZS')
  const kinaisha = formatExpirySwahili(expiresAt)
  return [
    'Osmani TV',
    '',
    'Hongera! Malipo yako yamefanikiwa.',
    '',
    `Kifurushi: ${pkg}`,
    `Bei: ${bei}`,
    `Kinaisha: ${kinaisha}`,
    '',
    'Asante kwa kutumia Osmani TV.',
  ].join('\n')
}

export function buildExpiryReminderSms({ planName, price, currency, expiresAt }) {
  const pkg = String(planName ?? '').trim() || 'Kifurushi'
  const bei = formatTzPrice(price, currency || 'TZS')
  const timePhrase = formatSwahiliClockTime(expiresAt)
  return [
    'Osmani TV',
    '',
    'Kumbusho!',
    '',
    `Kifurushi chako cha ${pkg} (${bei}) kinaisha kesho ${timePhrase}.`,
    '',
    'Lipia mapema ili uendelee kutazama Vipindi Vyote Live kupitia simu yako.',
    '',
    'Asante kwa kutumia Osmani TV.',
  ].join('\n')
}

function isGenericPackageName(planName) {
  const pkg = String(planName ?? '').trim()
  return !pkg || pkg.toLowerCase() === 'kifurushi'
}

/** Expired package line — never emit "Kifurushi chako cha Kifurushi". */
export function buildExpiredPackageLine({ planName, price, currency }) {
  const pkg = String(planName ?? '').trim()
  const hasPkg = pkg && pkg.toLowerCase() !== 'kifurushi'
  const priceNum = price != null ? Number(price) : NaN
  const hasPrice = Number.isFinite(priceNum) && priceNum > 0

  if (hasPkg && hasPrice) {
    return `Kifurushi chako cha ${pkg} (${formatTzPrice(priceNum, currency || 'TZS')}) kimeisha.`
  }
  if (hasPkg) {
    return `Kifurushi chako cha ${pkg} kimeisha.`
  }
  return 'Kifurushi chako kimeisha.'
}

export function buildExpiredSubscriptionSms({ planName, price, currency }) {
  const expiryLine = buildExpiredPackageLine({ planName, price, currency })
  return [
    'Osmani TV',
    '',
    expiryLine,
    '',
    'Ili uendelee kutazama vipindi vyote, tafadhali nunua kifurushi kipya kupitia Osmani TV.',
    '',
    'Asante kwa kutumia Osmani TV.',
  ].join('\n')
}

/** Stable id for one subscription billing period. */
export function subscriptionPeriodKey({ deviceId, transactionId, expiresAt }) {
  const d = String(deviceId ?? '').trim()
  const tx = String(transactionId ?? '').trim()
  const exp =
    expiresAt instanceof Date
      ? expiresAt.toISOString()
      : String(expiresAt ?? '').trim()
  return `${d}:${tx}:${exp}`
}
