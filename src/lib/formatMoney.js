/** Tanzania Shilling — e.g. TSh 3,000 */
export function formatTsh(amount) {
  const n = Number(amount)
  if (!Number.isFinite(n)) return 'TSh 0'
  const formatted = Math.round(n).toLocaleString('en-TZ')
  return `TSh ${formatted}`
}
