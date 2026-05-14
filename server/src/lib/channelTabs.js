/**
 * Osmani TV bottom tabs + admin parity.
 *
 * Mobile filtering (app not in this repo — contract for APK):
 * - Home: `visibleTabs` includes "Home" (mixed featured / cross-section).
 * - Sports: `visibleTabs` includes "Sports" AND `category === "Sports"`.
 * - Tamthilia: `visibleTabs` includes "Tamthilia" AND `category === "Tamthilia"`.
 *
 * Storage: `channels.category` = content line (Home | Sports | Tamthilia).
 *         `channels.bottom_tab` = comma-separated tab visibility, e.g. "Home,Sports".
 */

export const APP_TAB_ORDER = Object.freeze(['Home', 'Sports', 'Tamthilia'])

export const DEFAULT_CONTENT_CATEGORY = 'Home'

/** Legacy admin / app "display section" → current content line */
const LEGACY_TO_LINE = Object.freeze({
  sports: 'Sports',
  movies: 'Tamthilia',
  kids: 'Tamthilia',
  news: 'Tamthilia',
  music: 'Tamthilia',
  docs: 'Tamthilia',
  general: 'Home',
  tamthilia: 'Tamthilia',
  home: 'Home',
})

export function migrateContentCategory(raw) {
  const u = String(raw ?? '').trim()
  if (!u) return DEFAULT_CONTENT_CATEGORY
  const lower = u.toLowerCase()
  for (const t of APP_TAB_ORDER) {
    if (t.toLowerCase() === lower) return t
  }
  return LEGACY_TO_LINE[lower] || DEFAULT_CONTENT_CATEGORY
}

function canonTabToken(token) {
  const t = String(token ?? '').trim()
  if (!t) return ''
  const lower = t.toLowerCase()
  for (const x of APP_TAB_ORDER) {
    if (x.toLowerCase() === lower) return x
  }
  return LEGACY_TO_LINE[lower] || ''
}

/**
 * Parse `bottom_tab` CSV / legacy single value into ordered unique tab ids.
 * Always includes the content line tab so Sports-line channels stay on Sports unless admin unchecks (they can't uncheck line tab — enforced in UI).
 */
export function parseVisibleTabsFromBottomTabField(bottomTabRaw, categoryRaw) {
  const line = migrateContentCategory(categoryRaw)
  const raw = String(bottomTabRaw ?? '').trim()
  if (!raw) return APP_TAB_ORDER.filter((t) => t === line)
  const parts = raw
    .split(/[,;|]+/u)
    .map((p) => canonTabToken(p.trim()))
    .filter(Boolean)
  const set = new Set(parts)
  set.add(line)
  return APP_TAB_ORDER.filter((t) => set.has(t))
}

export function serializeVisibleTabs(tabs) {
  const set = new Set((Array.isArray(tabs) ? tabs : []).map((t) => String(t ?? '').trim()).filter(Boolean))
  return APP_TAB_ORDER.filter((t) => set.has(t)).join(',')
}

/** Admin form → ordered tab list (checkboxes + content line). */
export function tabsFromCheckboxState(displaySection, tabHome, tabSports, tabTamthilia) {
  const line = migrateContentCategory(displaySection)
  const picked = []
  if (tabHome) picked.push('Home')
  if (tabSports) picked.push('Sports')
  if (tabTamthilia) picked.push('Tamthilia')
  if (!picked.includes(line)) picked.push(line)
  return APP_TAB_ORDER.filter((t) => picked.includes(t))
}

export function checkboxStateFromTabs(tabs, displaySection) {
  const line = migrateContentCategory(displaySection)
  const arr = Array.isArray(tabs) ? tabs : parseVisibleTabsFromBottomTabField(String(tabs ?? ''), line)
  return {
    tabHome: arr.includes('Home'),
    tabSports: arr.includes('Sports'),
    tabTamthilia: arr.includes('Tamthilia'),
  }
}
