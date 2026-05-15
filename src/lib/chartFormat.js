/** Human-readable Y-axis ticks (avoids "0k" for small install counts). */
export function formatChartCountTick(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return ''
  const abs = Math.abs(n)
  if (abs >= 1_000_000) {
    const m = n / 1_000_000
    return `${m % 1 === 0 ? m.toFixed(0) : m.toFixed(1)}M`
  }
  if (abs >= 10_000) return `${Math.round(n / 1000)}k`
  if (abs >= 1_000) {
    const k = n / 1000
    return `${k % 1 === 0 ? k.toFixed(0) : k.toFixed(1)}k`
  }
  return Math.round(n).toLocaleString('en-US')
}

/** Nice Y domain + tick positions for area charts. */
export function computeChartYAxis(values) {
  const nums = (Array.isArray(values) ? values : [])
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
  if (nums.length === 0) {
    return { domain: [0, 10], ticks: [0, 2, 4, 6, 8, 10] }
  }
  const rawMin = Math.min(...nums, 0)
  const rawMax = Math.max(...nums, 0)
  const span = rawMax - rawMin || rawMax || 1
  const pad = Math.max(span * 0.12, rawMax > 0 ? rawMax * 0.05 : 1)
  let min = Math.floor(rawMin - pad)
  let max = Math.ceil(rawMax + pad)
  if (min < 0) min = 0
  if (max <= min) max = min + 10
  const roughStep = (max - min) / 5
  const mag = 10 ** Math.floor(Math.log10(roughStep || 1))
  const step = Math.max(1, Math.ceil(roughStep / mag) * mag)
  const ticks = []
  for (let t = min; t <= max + step * 0.01; t += step) {
    ticks.push(Math.round(t))
  }
  if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + step)
  return { domain: [min, ticks[ticks.length - 1]], ticks }
}

/** Summary stats for cumulative install series. */
export function computeInstallSeriesStats(points, valueKey = 'installs') {
  const rows = Array.isArray(points) ? points : []
  if (rows.length === 0) {
    return { total: 0, start: 0, end: 0, delta: 0, growthPct: null, points: 0 }
  }
  const start = Number(rows[0]?.[valueKey]) || 0
  const end = Number(rows[rows.length - 1]?.[valueKey]) || 0
  const delta = end - start
  let growthPct = null
  if (start > 0) growthPct = (delta / start) * 100
  else if (end > 0) growthPct = 100
  return { total: end, start, end, delta, growthPct, points: rows.length }
}
