/** Git SHA for the running API (Render / GitHub Actions / Vercel set these at deploy). */
export function getServerGitCommit() {
  const raw =
    process.env.RENDER_GIT_COMMIT ||
    process.env.GITHUB_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.CI_COMMIT_SHA ||
    ''
  const s = String(raw || '').trim()
  return s ? s.slice(0, 40) : 'unknown'
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
