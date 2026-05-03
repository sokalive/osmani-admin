import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, ClipboardList, Shield, XCircle } from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getSecurityLogs } from '../lib/api'
import { formatReadableDateTime } from '../lib/formatTxDisplay'

function isTransferAttempt(row) {
  const t = (row.eventType || '').toLowerCase()
  return t.includes('transfer') || t.includes('code')
}

function SecurityLogsPage() {
  const { showToast } = useToast()
  const [logs, setLogs] = useState([])

  const refresh = useCallback(async () => {
    try {
      const list = await getSecurityLogs()
      setLogs(Array.isArray(list) ? list : [])
    } catch (e) {
      showToast('error', e?.message || 'Could not load security logs')
      setLogs([])
    }
  }, [showToast])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    const id = window.setInterval(refresh, 45_000)
    return () => window.clearInterval(id)
  }, [refresh])

  const stats = useMemo(() => {
    let transferAttempts = 0
    let approved = 0
    let denied = 0
    for (const row of logs) {
      if (row.status === 'completed') approved += 1
      if (row.status === 'failed') denied += 1
      if (isTransferAttempt(row)) transferAttempts += 1
    }
    return {
      securityEvents: logs.length,
      transferAttempts,
      approved,
      denied,
    }
  }, [logs])

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-8">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Security Logs
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Full history of all security events — no deletion
          </p>
        </header>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <article className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-5 ring-1 ring-white/[0.04]">
            <div className="flex items-center gap-2 text-slate-400">
              <Shield className="h-5 w-5 text-sky-400" />
              <span className="text-xs font-semibold uppercase tracking-wide">Security Events</span>
            </div>
            <p className="mt-3 text-3xl font-bold tabular-nums text-white">{stats.securityEvents}</p>
          </article>
          <article className="rounded-2xl border border-amber-500/30 bg-amber-950/20 p-5 ring-1 ring-amber-500/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-400/90">
              Transfer Attempts
            </p>
            <p className="mt-3 text-3xl font-bold tabular-nums text-amber-50">{stats.transferAttempts}</p>
          </article>
          <article className="rounded-2xl border border-emerald-500/35 bg-emerald-950/25 p-5 ring-1 ring-emerald-500/20">
            <div className="flex items-center gap-2 text-emerald-400/90">
              <CheckCircle2 className="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-wide">Approved</span>
            </div>
            <p className="mt-3 text-3xl font-bold tabular-nums text-emerald-100">{stats.approved}</p>
          </article>
          <article className="rounded-2xl border border-red-500/35 bg-red-950/25 p-5 ring-1 ring-red-500/20">
            <div className="flex items-center gap-2 text-red-400/90">
              <XCircle className="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-wide">Denied</span>
            </div>
            <p className="mt-3 text-3xl font-bold tabular-nums text-red-100">{stats.denied}</p>
          </article>
        </section>

        <section>
          <h2 className="mb-3 flex items-center gap-2 text-lg font-semibold text-white">
            <ClipboardList className="h-5 w-5 text-amber-400" />
            Event log
          </h2>
          <ul className="space-y-3">
            {logs.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-slate-700/60 bg-slate-950/50 p-4 ring-1 ring-white/[0.04] transition-colors hover:border-slate-600/80"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-sm font-semibold text-amber-100/95">
                        {row.actor}
                      </span>
                      <span
                        className={`inline-flex rounded-lg px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${
                          row.status === 'completed'
                            ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/45'
                            : 'bg-red-500/20 text-red-200 ring-red-400/45'
                        }`}
                      >
                        {row.status === 'completed' ? 'Completed' : 'Failed'}
                      </span>
                    </div>
                    <p className="mt-2 text-sm font-medium text-white">{row.eventType}</p>
                    {row.detail ? (
                      <p className="mt-1 font-mono text-xs text-slate-400">{row.detail}</p>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right">
                    <p className="text-xs text-slate-500">
                      {formatReadableDateTime(row.timestamp)}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </>
  )
}

export default SecurityLogsPage
