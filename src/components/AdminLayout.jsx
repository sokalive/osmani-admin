import { useEffect, useState } from 'react'
import Sidebar from './Sidebar'
import { API_BASE, getAdminPanelDiagnostics, getApiHealth } from '../lib/api'

function shortSha(s) {
  const t = String(s || '').trim()
  if (!t || t === 'unknown') return t || '—'
  return t.length > 7 ? t.slice(0, 7) : t
}

function DeployFooter() {
  const build = typeof globalThis !== 'undefined' ? globalThis.__OSMANI_ADMIN_BUILD__ : null
  const buildCommit = build?.commit ?? '—'
  const [apiHealth, setApiHealth] = useState(null)
  const [panel, setPanel] = useState(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const h = await getApiHealth()
        if (!cancelled) setApiHealth(h)
      } catch {
        if (!cancelled) setApiHealth(null)
      }
      try {
        const d = await getAdminPanelDiagnostics()
        if (!cancelled) setPanel(d)
      } catch {
        if (!cancelled) setPanel(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const apiCommit = apiHealth?.commit ?? apiHealth?.git_commit
  const db = panel?.database
  const dbLine =
    db && db.configured && db.host
      ? `${db.host}${db.database ? ` / ${db.database}` : ''}`
      : db && db.configured === false
        ? 'DATABASE_URL unset'
        : panel?.ok
          ? 'DB …'
          : '—'

  return (
    <footer className="border-t border-slate-800/80 bg-[#0B0F1A]/95 px-6 py-2 text-[10px] text-slate-500">
      <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-4 gap-y-1 font-mono">
        <span title={`Full build: ${buildCommit}\nBuilt: ${build?.builtAt ?? ''}`}>
          UI build <span className="text-slate-400">{shortSha(buildCommit)}</span>
        </span>
        <span className="text-slate-600" aria-hidden>
          |
        </span>
        <span title={apiHealth?.time ? `API time: ${apiHealth.time}` : API_BASE}>
          API <span className="text-slate-400">{shortSha(apiCommit) || '—'}</span>
          <span className="text-slate-600"> · </span>
          <span className="break-all text-slate-500">{API_BASE}</span>
        </span>
        {panel?.ok ? (
          <>
            <span className="text-slate-600" aria-hidden>
              |
            </span>
            <span title={panel.zenopay_row ? JSON.stringify(panel.zenopay_row) : ''}>
              DB <span className="text-slate-400">{dbLine}</span>
              {typeof panel.manual_grants_visible_count === 'number' ? (
                <span className="text-slate-600"> · grants:{panel.manual_grants_visible_count}</span>
              ) : null}
            </span>
          </>
        ) : null}
      </div>
      <p className="mx-auto mt-1 max-w-[1400px] text-[9px] text-slate-600">
        Compare UI build vs API commit after each deploy. Mismatch means stale static assets or wrong service.
        Open console for <code className="text-slate-500">__OSMANI_ADMIN_BUILD__</code>.
      </p>
    </footer>
  )
}

export default function AdminLayout({ children }) {
  return (
    <div className="min-h-screen bg-[#0B0F1A] text-slate-100">
      <Sidebar />
      <div className="ml-[280px] flex min-h-screen flex-col">
        <div className="mx-auto flex w-full max-w-[1400px] flex-1 flex-col p-6">{children}</div>
        <DeployFooter />
      </div>
    </div>
  )
}
