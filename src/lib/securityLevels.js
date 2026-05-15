export const SECURITY_LEVELS = ['warning', 'limited', 'blocked', 'critical']

export function levelBadgeClass(level) {
  switch (String(level || '').toLowerCase()) {
    case 'critical':
      return 'bg-fuchsia-500/20 text-fuchsia-200 ring-fuchsia-500/40'
    case 'blocked':
      return 'bg-red-500/20 text-red-200 ring-red-500/40'
    case 'limited':
      return 'bg-amber-500/20 text-amber-200 ring-amber-500/40'
    case 'warning':
    default:
      return 'bg-sky-500/20 text-sky-200 ring-sky-500/40'
  }
}

export function boolIcon(v) {
  return v ? 'text-red-400' : 'text-slate-500'
}
