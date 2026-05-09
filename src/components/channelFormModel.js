export const SECTION_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'sports', label: 'Sports' },
  { value: 'movies', label: 'Movies' },
  { value: 'kids', label: 'Kids' },
  { value: 'news', label: 'News' },
  { value: 'music', label: 'Music' },
  { value: 'docs', label: 'Docs' },
]

const SECTION_LABEL_BY_VALUE = Object.fromEntries(SECTION_OPTIONS.map((x) => [x.value, x.label]))

export function sectionValueToLabel(value) {
  const v = String(value ?? '').trim().toLowerCase()
  return SECTION_LABEL_BY_VALUE[v] || 'General'
}

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
    displaySection: 'general',
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
    displaySection: String(channel.displaySection ?? channel.display_section ?? 'general')
      .trim()
      .toLowerCase() || 'general',
    streamUrlPrimary: channel.streamUrlPrimary ?? '',
    backupStream1: channel.backupStream1 ?? '',
    backupStream2: channel.backupStream2 ?? '',
    origin: channel.origin ?? '',
    referer: channel.referer ?? '',
    userAgent: channel.userAgent ?? '',
    playerType: channel.playerType ?? 'Exo',
    accessPremium: Boolean(channel.accessPremium),
    bottomTabsDisplay:
      channel.bottomTabsDisplay ??
      channel.bottomTab ??
      sectionValueToLabel(channel.displaySection ?? channel.display_section) ??
      'General',
    live: Boolean(channel.live),
    hd: channel.hd !== false,
    active: channel.active !== false,
    showInApp: channel.showInApp !== false,
  }
}
