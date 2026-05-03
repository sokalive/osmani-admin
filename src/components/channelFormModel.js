export const SECTION_OPTIONS = [
  'Sports',
  'Movies',
  'Kids',
  'News',
  'Music',
  'Docs',
  'General',
]

export const PLAYER_TYPES = ['Exo', 'WebView', 'VLC', 'Native', 'IJK']

export function formSelectClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

export function formInputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

export function formLabelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

export function emptyFormState() {
  return {
    id: '',
    name: '',
    displaySection: 'General',
    streamUrlPrimary: '',
    backupStream1: '',
    backupStream2: '',
    origin: '',
    referer: '',
    userAgent: '',
    playerType: 'Exo',
    accessPremium: false,
    bottomTabsDisplay: 'General',
    live: true,
    hd: true,
    active: true,
    showInApp: true,
  }
}

export function channelToForm(channel) {
  if (!channel) return emptyFormState()
  return {
    id: channel.id,
    name: channel.name ?? '',
    displaySection: channel.displaySection ?? channel.category ?? 'General',
    streamUrlPrimary: channel.streamUrlPrimary ?? '',
    backupStream1: channel.backupStream1 ?? '',
    backupStream2: channel.backupStream2 ?? '',
    origin: channel.origin ?? '',
    referer: channel.referer ?? '',
    userAgent: channel.userAgent ?? '',
    playerType: channel.playerType ?? 'Exo',
    accessPremium: Boolean(channel.accessPremium),
    bottomTabsDisplay: channel.bottomTabsDisplay ?? channel.category ?? 'General',
    live: Boolean(channel.live),
    hd: channel.hd !== false,
    active: channel.active !== false,
    showInApp: channel.showInApp !== false,
  }
}
