/**
 * Regression: Render static admin must never post uploads to the Render Node API disk.
 * Usage: node server/scripts/regression-admin-api-base.mjs
 */

function hostOf(urlOrOrigin) {
  return String(urlOrOrigin || '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    .toLowerCase()
}

const VPS = 'https://api.osmanitv.com/api'
const RENDER_SPA = 'https://osmani-admin-mpya.onrender.com'
const RENDER_API = 'https://osmani-admin-api.onrender.com'

function normalizeApiBase(raw, windowOrigin) {
  if (windowOrigin && hostOf(windowOrigin) === 'osmani-admin-mpya.onrender.com') return VPS
  const s = String(raw || '').trim()
  if (s) {
    const clean = s.replace(/\/$/, '')
    const withApi = /\/api$/i.test(clean) ? clean : `${clean}/api`
    if (hostOf(withApi) === 'osmani-admin-api.onrender.com') return VPS
    return withApi
  }
  if (windowOrigin) {
    if (hostOf(windowOrigin) === 'osmani-admin-mpya.onrender.com') return VPS
    return `${String(windowOrigin).replace(/\/$/, '')}/api`
  }
  return '/api'
}

const failures = []
function check(name, actual, expected) {
  const ok = actual === expected
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}\n       got ${actual}\n       want ${expected}`)
  if (!ok) failures.push(name)
}

check(
  'Render SPA + baked Render API env → VPS',
  normalizeApiBase(RENDER_API, RENDER_SPA),
  VPS,
)
check(
  'Render SPA + empty env → VPS',
  normalizeApiBase('', RENDER_SPA),
  VPS,
)
check(
  'Contabo Admin same-origin',
  normalizeApiBase('', 'https://admin.osmanitv.com'),
  'https://admin.osmanitv.com/api',
)
check(
  'Explicit VPS env preserved',
  normalizeApiBase(VPS, 'https://admin.osmanitv.com'),
  VPS,
)
check(
  'Stale Render API env on Contabo still rewritten (wrong disk)',
  normalizeApiBase(RENDER_API, 'https://admin.osmanitv.com'),
  VPS,
)

if (failures.length) {
  console.error(`\n${failures.length} failed`)
  process.exit(1)
}
console.log('\nAll admin API base regression checks passed.')
