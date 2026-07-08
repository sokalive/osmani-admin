import {
  APP_TAB_ORDER,
  DEFAULT_CONTENT_CATEGORY,
  checkboxStateFromTabs,
  migrateContentCategory,
  parseVisibleTabsFromBottomTabField,
} from '../../server/src/lib/channelTabs.js'

export const SECTION_OPTIONS = [...APP_TAB_ORDER]

export const PLAYER_TYPES = ['Exo', 'WebView', 'VLC', 'Native', 'IJK', 'Direct HLS']

export function formSelectClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

export function formInputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

export function formLabelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

export const INSTRUCTION_VISIBILITY_OPTIONS = [
  { value: 'all', label: 'Show to all users' },
  { value: 'below_v24', label: 'Show only to versions below v24' },
  { value: 'hide_v24_plus', label: 'Hide from v24+ users' },
]

export function emptyFormState() {
  return {
    id: '',
    name: '',
    displaySection: DEFAULT_CONTENT_CATEGORY,
    tabHome: true,
    tabSports: false,
    tabTamthilia: false,
    streamUrlPrimary: '',
    backupStream1: '',
    backupStream2: '',
    origin: '',
    referer: '',
    userAgent: '',
    playerType: 'Exo',
    accessPremium: false,
    live: true,
    hd: true,
    active: true,
    showInApp: true,
    isInstructionVideo: false,
    isSystemLocked: false,
    instructionVisibility: 'all',
    videoUrl: '',
  }
}

export function channelToForm(channel) {
  if (!channel) return emptyFormState()
  const category = migrateContentCategory(channel.displaySection ?? channel.category)
  const bottomStr = String(
    channel.bottomTabsDisplay ?? channel.bottomTab ?? channel.bottom_tab ?? '',
  ).trim()
  const visibleTabs = parseVisibleTabsFromBottomTabField(bottomStr, category)
  const checks = checkboxStateFromTabs(visibleTabs, category)
  return {
    id: channel.id,
    name: channel.name ?? '',
    displaySection: category,
    tabHome: checks.tabHome,
    tabSports: checks.tabSports,
    tabTamthilia: checks.tabTamthilia,
    streamUrlPrimary: channel.streamUrlPrimary ?? '',
    backupStream1: channel.backupStream1 ?? '',
    backupStream2: channel.backupStream2 ?? '',
    origin: channel.origin ?? '',
    referer: channel.referer ?? '',
    userAgent: channel.userAgent ?? '',
    playerType: channel.playerType ?? 'Exo',
    accessPremium: Boolean(channel.accessPremium),
    live: Boolean(channel.live),
    hd: channel.hd !== false,
    active: channel.active !== false,
    showInApp: channel.showInApp !== false,
    isInstructionVideo: Boolean(channel.isInstructionVideo),
    isSystemLocked: Boolean(channel.isSystemLocked),
    instructionVisibility: String(channel.instructionVisibility ?? 'all'),
    videoUrl: channel.videoUrl ?? '',
  }
}
