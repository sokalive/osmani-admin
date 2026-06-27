const EAT = 'Africa/Dar_es_Salaam'

export function formatTzPrice(amount, currency = 'TZS') {
  const n = Math.round(Number(amount))
  if (!Number.isFinite(n)) return `${currency} 0`
  return `${currency} ${n.toLocaleString('en-US')}`
}

/** Example: 04 Jul 2026 saa 14:35 */
export function formatExpirySwahili(dateInput) {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput)
  if (Number.isNaN(d.getTime())) return ''
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
  const hour = get('hour').padStart(2, '0')
  const minute = get('minute').padStart(2, '0')
  return `${get('day')} ${get('month')} ${get('year')} saa ${hour}:${minute}`
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
  const when = formatExpirySwahili(expiresAt)
  const timePart = when.includes(' saa ') ? when.split(' saa ').pop() : when
  return [
    'Osmani TV',
    '',
    'Kumbusho!',
    '',
    `Kifurushi chako cha ${pkg} (${bei}) kinaisha kesho saa ${timePart}.`,
    '',
    'Lipia mapema ili uendelee kutazama bila kukatizwa.',
    '',
    'Asante kwa kutumia Osmani TV.',
  ].join('\n')
}

export function buildExpiredSubscriptionSms({ planName }) {
  const pkg = String(planName ?? '').trim() || 'Kifurushi'
  return [
    'Osmani TV',
    '',
    `Kifurushi chako cha ${pkg} kimeisha.`,
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
