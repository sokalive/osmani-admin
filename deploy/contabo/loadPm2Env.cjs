/**
 * Load Contabo PM2 env from disk (server/.env + repo .env + .env.cutover).
 * PM2 does not reliably inherit shell exports; this matches server/src/loadEnv.js order.
 */
const fs = require('node:fs')
const path = require('node:path')

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

function loadEnvFile(filePath, into, { override = false } = {}) {
  if (!filePath || !fs.existsSync(filePath)) return false
  const text = fs.readFileSync(filePath, 'utf8')
  let wrote = false
  for (const line of text.split(/\r?\n/)) {
    const parsed = parseEnvLine(line)
    if (!parsed) continue
    if (override || into[parsed.key] === undefined || into[parsed.key] === '') {
      into[parsed.key] = parsed.value
      wrote = true
    }
  }
  return wrote
}

function shouldLoadCutoverEnv(into) {
  const flag = String(into.OSMANI_LOAD_CUTOVER_ENV ?? '1').trim().toLowerCase()
  if (['0', 'false', 'no', 'off'].includes(flag)) return false
  if (String(into.RENDER || '').trim().toLowerCase() === 'true') return false
  return true
}

/**
 * @param {string} root Repo root (e.g. /var/www/osmani-admin-api)
 */
function loadContaboPm2Env(root) {
  const apiDir = path.join(root, 'server')
  const merged = { ...process.env }

  if (shouldLoadCutoverEnv(merged)) {
    for (const filePath of [
      path.join(apiDir, '.env.cutover'),
      path.join(root, '.env.cutover'),
    ]) {
      loadEnvFile(filePath, merged, { override: false })
    }
  }

  for (const filePath of [
    path.join(apiDir, '.env'),
    path.join(root, '.env'),
    path.join(apiDir, '.env.local'),
    path.join(root, '.env.local'),
    path.join(apiDir, '.env.backup'),
    path.join(root, '.env.backup'),
    '/root/.osmani-admin.env',
  ]) {
    loadEnvFile(filePath, merged, { override: true })
  }

  merged.NODE_ENV = merged.NODE_ENV || 'production'
  merged.PORT = merged.PORT || '10001'
  merged.OSMANI_ADMIN_ROOT = root
  merged.OSMANI_LOAD_CUTOVER_ENV = merged.OSMANI_LOAD_CUTOVER_ENV || '1'

  try {
    const { execSync } = require('node:child_process')
    const sha = execSync('git rev-parse HEAD', {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    if (sha) merged.OSMANI_GIT_COMMIT = sha.slice(0, 40)
  } catch {
    // ignore
  }

  return merged
}

module.exports = { loadContaboPm2Env, loadEnvFile }
