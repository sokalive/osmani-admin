/**
 * Force mandatory admin session flags and drop obsolete admin API token keys.
 * Prints key names only, never values.
 */
import fs from 'node:fs'

const root = process.argv[2] || '/var/www/osmani-admin-api'
const files = [`${root}/server/.env`, `${root}/.env`]
const drop = new Set(['ADMIN_API_TOKEN', 'APP_UPDATE_ADMIN_TOKEN'])
const force = {
  ADMIN_PANEL_AUTH_REQUIRED: 'true',
  ADMIN_PANEL_LEGACY_TOKEN_FALLBACK: 'false',
  ADMIN_TRUSTED_INSTALL: '0',
}

for (const file of files) {
  if (!fs.existsSync(file)) {
    console.log(`skip-missing ${file.split('/').pop()}`)
    continue
  }
  const original = fs.readFileSync(file, 'utf8')
  const lines = original.split(/\n/)
  const seen = new Set()
  const dropped = []
  const out = []
  for (const line of lines) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line)
    if (match && drop.has(match[1])) {
      dropped.push(match[1])
      continue
    }
    if (match && Object.prototype.hasOwnProperty.call(force, match[1])) {
      out.push(`${match[1]}=${force[match[1]]}`)
      seen.add(match[1])
      continue
    }
    out.push(line)
  }
  for (const [key, value] of Object.entries(force)) {
    if (!seen.has(key)) out.push(`${key}=${value}`)
  }
  const next = out.join('\n').replace(/\n{3,}/g, '\n\n')
  if (next !== original) fs.writeFileSync(file, next.endsWith('\n') ? next : `${next}\n`)
  console.log(
    `env-hardened file=${file.split('/').pop()} dropped=${dropped.length ? dropped.join(',') : 'none'}`,
  )
}
