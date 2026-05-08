import { execSync } from 'node:child_process'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function resolveGitCommit() {
  const fromCi =
    process.env.RENDER_GIT_COMMIT ||
    process.env.GITHUB_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.CI_COMMIT_SHA ||
    ''
  if (fromCi) return String(fromCi).trim().slice(0, 40)
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim().slice(0, 40)
  } catch {
    return 'unknown'
  }
}

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const commit = resolveGitCommit()
  const builtAt = new Date().toISOString()

  return {
    plugins: [react(), tailwindcss()],
    define: {
      __ADMIN_BUILD_COMMIT__: JSON.stringify(commit),
      __ADMIN_BUILD_TIME__: JSON.stringify(builtAt),
      __ADMIN_BUILD_VITE_MODE__: JSON.stringify(mode),
    },
  }
})
