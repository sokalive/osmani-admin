import { execSync } from 'node:child_process'

/** Git SHA for the running API (Render / GitHub Actions / VPS deploy set these at deploy). */
export function getServerGitCommit() {
  const raw =
    process.env.RENDER_GIT_COMMIT ||
    process.env.GITHUB_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.CI_COMMIT_SHA ||
    process.env.OSMANI_GIT_COMMIT ||
    ''
  const s = String(raw || '').trim()
  if (s) return s.slice(0, 40)
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .trim()
      .slice(0, 40)
  } catch {
    return 'unknown'
  }
}

/** Default public API origin — never Render; VPS uses BASE_URL / request host. */
export function defaultPublicApiOrigin() {
  const fromEnv = String(process.env.BASE_URL || process.env.STREAM_API_BASE_URL || '')
    .trim()
    .replace(/\/+$/, '')
  if (fromEnv) return fromEnv
  return 'https://api.osmanitv.com'
}

/** Non-secret fingerprint so ops can confirm all instances point at the same DB. */
export function getDatabaseUrlFingerprint() {
  const u = String(process.env.DATABASE_URL || '').trim()
  if (!u) return { configured: false }
  try {
    const url = new URL(u)
    const dbName = String(url.pathname || '')
      .replace(/^\//, '')
      .split('/')[0]
      .split('?')[0]
    return {
      configured: true,
      host: url.hostname,
      port: url.port || null,
      database: dbName || null,
    }
  } catch {
    return { configured: true, parseError: true }
  }
}
