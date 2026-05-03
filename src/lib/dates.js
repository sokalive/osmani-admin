/** Start of calendar day in local timezone */
export function startOfDay(d) {
  const x = new Date(d)
  x.setHours(0, 0, 0, 0)
  return x
}

export function endOfDay(d) {
  const x = new Date(d)
  x.setHours(23, 59, 59, 999)
  return x
}

export function isDateInRange(iso, fromDate, toDate) {
  const t = new Date(iso).getTime()
  return t >= startOfDay(fromDate).getTime() && t <= endOfDay(toDate).getTime()
}

export function isSameLocalDay(iso, day) {
  const a = new Date(iso)
  const b = new Date(day)
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}
