import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {string[]} */
let loadedPaths = []

function parseEnvLine(line) {
  let trimmed = String(line || '').trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  if (trimmed.startsWith('export ')) trimmed = trimmed.slice(7).trim()
  const eq = trimmed.indexOf('=')
  if (eq <= 0) return null
  const key = trimmed.slice(0, eq).trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null
  let value = trimmed.slice(eq + 1).trim()
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1)
  }
  return { key, value }
}

function loadEnvFile(filePath, { override = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const text = fs.readFileSync(filePath, 'utf8')
  let wrote = false
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    if (override || process.env[parsed.key] === undefined || process.env[parsed.key] === '') {
      process.env[parsed.key] = parsed.value
      wrote = true
    }
  }
  if (wrote) loadedPaths.push(filePath)
  return wrote
}

function shouldLoadCutoverEnv() {
  const flag = String(process.env.OSMANI_LOAD_CUTOVER_ENV ?? '').trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(flag)) return true
  if (['0', 'false', 'no', 'off'].includes(flag)) return false
  // Repo ships Contabo defaults in .env.cutover — never auto-apply on Render (breaks legacy APK stream URLs).
  if (String(process.env.RENDER || '').trim().toLowerCase() === 'true') return false
  return false
}

/**
 * Copied-project flags must not disable Osmani admin authentication.
 * ADMIN_TRUSTED_INSTALL, LUQMAN_VPS, and similar switches are ignored.
 */
function copiedProjectAuthBypassRequested() {
  const keys = ['ADMIN_TRUSTED_INSTALL', 'LUQMAN_VPS', 'LUQMAN_TRUSTED_INSTALL']
  return keys.some((key) => {
    const value = String(process.env[key] ?? '').trim().toLowerCase()
    return ['1', 'true', 'yes', 'on'].includes(value)
  })
}

/**
 * Load env files for Contabo/Render:
 * 1. .env.cutover — Contabo-only when OSMANI_LOAD_CUTOVER_ENV=1 (or non-Render local cutover testing)
 * 2. server/.env, repo-root/.env — secrets (DATABASE_URL); override cutover
 */
export function loadProcessEnv() {
  loadedPaths = []
  const serverRoot = path.join(__dirname, '..')
  const repoRoot = path.join(serverRoot, '..')

  const cutoverFiles = shouldLoadCutoverEnv()
    ? [path.join(serverRoot, '.env.cutover'), path.join(process.cwd(), '.env.cutover')]
    : []
  const secretFiles = [
    path.join(serverRoot, '.env'),
    path.join(repoRoot, '.env'),
    path.join(process.cwd(), '.env'),
    path.join(serverRoot, '.env.local'),
    path.join(repoRoot, '.env.local'),
  ]

  const seen = new Set()
  for (const filePath of cutoverFiles) {
    if (seen.has(filePath)) continue
    seen.add(filePath)
    loadEnvFile(filePath, { override: false })
  }
  for (const filePath of secretFiles) {
    if (seen.has(filePath)) continue
    seen.add(filePath)
    loadEnvFile(filePath, { override: true })
  }

  // Mandatory session auth. Env files and copied-project flags cannot turn this off.
  if (copiedProjectAuthBypassRequested()) {
    console.warn(
      '[admin-auth] ignored copied-project flag that would disable admin login (LUQMAN_VPS / ADMIN_TRUSTED_INSTALL)',
    )
  }
  process.env.ADMIN_PANEL_AUTH_REQUIRED = 'true'
  process.env.ADMIN_PANEL_LEGACY_TOKEN_FALLBACK = 'false'
  process.env.ADMIN_TRUSTED_INSTALL = '0'

  return [...loadedPaths]
}

export function isDatabaseUrlConfigured() {
  return Boolean(String(process.env.DATABASE_URL || '').trim())
}

export function getLoadedEnvPaths() {
  return [...loadedPaths]
}

loadProcessEnv()
