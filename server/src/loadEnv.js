import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** @type {string[]} */
let loadedPaths = []

function parseEnvLine(line) {
  const trimmed = String(line || '').trim()
  if (!trimmed || trimmed.startsWith('#')) return null
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
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    if (override || process.env[parsed.key] === undefined || process.env[parsed.key] === '') {
      process.env[parsed.key] = parsed.value
    }
  }
  loadedPaths.push(filePath)
  return true
}

/**
 * Load server/.env then server/.env.cutover (Contabo non-secret defaults).
 * PM2 does not reliably apply ecosystem `env_file` — load before any other imports.
 */
export function loadProcessEnv() {
  loadedPaths = []
  const serverRoot = path.join(__dirname, '..')
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(serverRoot, '.env'),
    path.join(serverRoot, '.env.cutover'),
    path.join(process.cwd(), '.env.cutover'),
  ]
  const seen = new Set()
  for (const filePath of candidates) {
    if (seen.has(filePath)) continue
    seen.add(filePath)
    loadEnvFile(filePath, { override: false })
  }
  return [...loadedPaths]
}

export function getLoadedEnvPaths() {
  return [...loadedPaths]
}

loadProcessEnv()
