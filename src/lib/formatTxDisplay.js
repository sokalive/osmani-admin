const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
]

function pad2(n) {
  return String(n).padStart(2, '0')
}

/** e.g. 01 May 2026, 12:30 PM */
export function formatReadableDateTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  const day = pad2(d.getDate())
  const month = MONTHS[d.getMonth()]
  const year = d.getFullYear()
  let h = d.getHours()
  const min = pad2(d.getMinutes())
  const ampm = h >= 12 ? 'PM' : 'AM'
  h = h % 12
  if (h === 0) h = 12
  return `${day} ${month} ${year}, ${h}:${min} ${ampm}`
}
