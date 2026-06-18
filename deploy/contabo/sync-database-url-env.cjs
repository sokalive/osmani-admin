#!/usr/bin/env node
/**
 * Find live DATABASE_URL (disk + PM2) and ensure a quoted line in server/.env.
 * Bash `source` on .env breaks when passwords contain $, !, &, etc.; Node parsing does not.
 *
 * Usage: node deploy/contabo/sync-database-url-env.cjs [/var/www/osmani-admin-api]
 */
const fs = require('node:fs')
const path = require('node:path')
const { execSync } = require('node:child_process')
const { loadContaboPm2Env, loadEnvFile } = require('./loadPm2Env.cjs')

const ROOT = process.argv[2] || process.env.OSMANI_ADMIN_ROOT || '/var/www/osmani-admin-api'
const API_DIR = path.join(ROOT, 'server')
const ENV_FILE = path.join(API_DIR, '.env')

const FILE_CANDIDATES = [
  path.join(API_DIR, '.env'),
  path.join(ROOT, '.env'),
  path.join(API_DIR, '.env.local'),
  path.join(ROOT, '.env.local'),
  path.join(API_DIR, '.env.backup'),
  path.join(ROOT, '.env.backup'),
  '/root/.osmani-admin.env',
]

function fingerprint(url) {
  const s = String(url || '').trim()
  if (!s) return '(empty)'
  try {
    const normalized = s.replace(/^postgres(ql)?:\/\//i, 'http://')
    const u = new URL(normalized)
    const db = (u.pathname || '').replace(/^\//, '') || '(unknown)'
    return `${u.hostname}:${u.port || '5432'}/${db}`
  } catch {
    return '(unparseable)'
  }
}

function readFromFile(filePath) {
  const into = {}
  if (!loadEnvFile(filePath, into, { override: true })) return null
  const value = String(into.DATABASE_URL || '').trim()
  if (!value) return null
  return { value, source: filePath }
}

function readFromPm2() {
  try {
    const raw = execSync('pm2 jlist', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const list = JSON.parse(raw)
    const app = list.find((a) => a && a.name === 'osmani-admin-api')
    const env = app?.pm2_env || {}
    const value = String(env.DATABASE_URL || env.env?.DATABASE_URL || '').trim()
    if (!value) return null
    return { value, source: 'pm2:osmani-admin-api' }
  } catch {
    return null
  }
}

function findDatabaseUrl() {
  for (const filePath of FILE_CANDIDATES) {
    const hit = readFromFile(filePath)
    if (hit) return hit
  }

  const fromLoader = String(loadContaboPm2Env(ROOT).DATABASE_URL || '').trim()
  if (fromLoader) {
    return { value: fromLoader, source: 'loadContaboPm2Env' }
  }

  return readFromPm2()
}

function quoteEnvValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function ensureQuotedLineInEnvFile(value) {
  const line = `DATABASE_URL=${quoteEnvValue(value)}`
  let text = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf8') : ''
  const re = /^[ \t]*(export[ \t]+)?DATABASE_URL=.*$/m

  if (!fs.existsSync(ENV_FILE)) {
    fs.mkdirSync(API_DIR, { recursive: true })
  }

  let next
  let restored = false
  if (re.test(text)) {
    const replaced = text.replace(re, line)
    if (replaced !== text) {
      next = replaced
      restored = true
    } else {
      // Line exists; re-write if unquoted (bash source unsafe).
      const current = readFromFile(ENV_FILE)
      if (current?.value === value && !/^DATABASE_URL="/m.test(text)) {
        next = text.replace(re, line)
        restored = true
      } else {
        next = text
      }
    }
  } else {
    if (text && !text.endsWith('\n')) text += '\n'
    next = text + line + '\n'
    restored = true
  }

  if (restored) {
    if (!next.endsWith('\n')) next += '\n'
    fs.writeFileSync(ENV_FILE, next, { mode: 0o600 })
  }

  return restored
}

console.log('==> DATABASE_URL discovery')
for (const filePath of FILE_CANDIDATES) {
  const exists = fs.existsSync(filePath)
  const has = exists && readFromFile(filePath)
  console.log(`    ${exists ? 'file' : 'miss'} ${filePath}${has ? ' (has DATABASE_URL)' : ''}`)
}

const found = findDatabaseUrl()
if (!found?.value) {
  console.error('ERROR: DATABASE_URL not found on disk or in PM2.')
  console.error(`Add Vultr PostgreSQL URL to ${ENV_FILE}`)
  process.exit(1)
}

const restored = ensureQuotedLineInEnvFile(found.value)
const fp = fingerprint(found.value)
console.log(
  `OK DATABASE_URL source=${found.source} fingerprint=${fp} len=${found.value.length}${
    restored ? ' action=restored-quoted-line-in-server/.env' : ''
  }`,
)
