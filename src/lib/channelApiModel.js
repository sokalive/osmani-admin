const CATEGORY_GRADIENTS = {
  Sports: 'from-red-600 to-rose-700',
  News: 'from-blue-600 to-indigo-700',
  Movies: 'from-violet-600 to-purple-800',
  Kids: 'from-emerald-500 to-teal-700',
  Music: 'from-fuchsia-600 to-pink-700',
  Docs: 'from-amber-600 to-orange-800',
  General: 'from-indigo-600 to-purple-700',
}

/** API row → UI channel object for table + modal */
export function uiFromApiRow(c) {
  const category = c.category || 'General'
  return {
    id: String(c.id),
    name: c.name ?? '',
    category,
    displaySection: category,
    bottomTabsDisplay: c.bottomTabsDisplay ?? category,
    logoLetter: (c.name?.[0] ?? '?').toUpperCase(),
    logoGradient: CATEGORY_GRADIENTS[category] || 'from-indigo-600 to-purple-700',
    accessPremium: Boolean(c.accessPremium),
    live: Boolean(c.live),
    hd: c.hd !== false,
    active: c.active !== false,
    showInApp: c.showInApp !== false,
    streamUrlPrimary: c.url ?? '',
    backupStream1: c.backupStream1 ?? '',
    backupStream2: c.backupStream2 ?? '',
    origin: c.origin ?? '',
    referer: c.referer ?? '',
    userAgent: c.userAgent ?? '',
    playerType: c.playerType ?? 'Exo',
    thumbnailUrl: c.thumbnailUrl ?? null,
  }
}

/** Modal submit payload → JSON body for POST/PUT */
export function apiBodyFromFormSubmit(s) {
  return {
    name: s.name?.trim() ?? '',
    category: (s.displaySection ?? 'General').trim() || 'General',
    url: (s.streamUrlPrimary ?? '').trim(),
    backupStream1: (s.backupStream1 ?? '').trim(),
    backupStream2: (s.backupStream2 ?? '').trim(),
    origin: (s.origin ?? '').trim(),
    referer: (s.referer ?? '').trim(),
    userAgent: (s.userAgent ?? '').trim(),
    playerType: (s.playerType ?? 'Exo').trim() || 'Exo',
    accessPremium: Boolean(s.accessPremium),
    live: Boolean(s.live),
    hd: s.hd !== false,
    active: s.active !== false,
    showInApp: s.showInApp !== false,
    thumbnailUrl: typeof s.thumbnailPreviewUrl === 'string' && !s.thumbnailPreviewUrl.startsWith('blob:')
      ? s.thumbnailPreviewUrl
      : null,
  }
}

/** UI channel → API body (e.g. toggle access / quick PATCH-style update) */
export function apiBodyFromUiChannel(ch) {
  return {
    name: ch.name ?? '',
    category: ch.category ?? ch.displaySection ?? 'General',
    url: ch.streamUrlPrimary ?? '',
    backupStream1: ch.backupStream1 ?? '',
    backupStream2: ch.backupStream2 ?? '',
    origin: ch.origin ?? '',
    referer: ch.referer ?? '',
    userAgent: ch.userAgent ?? '',
    playerType: ch.playerType ?? 'Exo',
    accessPremium: Boolean(ch.accessPremium),
    live: Boolean(ch.live),
    hd: ch.hd !== false,
    active: ch.active !== false,
    showInApp: ch.showInApp !== false,
    thumbnailUrl: ch.thumbnailUrl ?? null,
  }
}
