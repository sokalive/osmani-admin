import { useCallback, useEffect, useMemo, useState } from 'react'
import { ClipboardList, Shield, Trash2 } from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { deleteSecurityLog, getSecurityLogs, postSecurityLogsBulkDelete, syncStreamUrl } from '../lib/api'
import { formatReadableDateTime } from '../lib/formatTxDisplay'

function isTransferAttempt(row) {
  const t = (row.eventType || '').toLowerCase()
  return t.includes('transfer') || t.includes('code')
}

function SecurityLogsPage() {
  const { showToast } = useToast()
  const [logs, setLogs] = useState([])
  const [selected, setSelected] = useState(() => new Set())

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

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onRefresh = () => {
      void refresh()
    }
    es.addEventListener('security_event_logged', onRefresh)
    es.addEventListener('security_logs_changed', onRefresh)
    es.addEventListener('security_alerts_changed', onRefresh)
    es.addEventListener('transfer_requested', onRefresh)
    es.addEventListener('transfer_completed', onRefresh)
    es.addEventListener('transfer_rejected', onRefresh)
    es.addEventListener('subscription_revoked', onRefresh)
    return () => es.close()
  }, [refresh])

  const stats = useMemo(() => {
    let transferEvents = 0
    let completedTransfers = 0
    let failedTransfers = 0
    for (const row of logs) {
      const isTransfer = isTransferAttempt(row)
      if (!isTransfer) continue
      transferEvents += 1
      if (row.status === 'completed') completedTransfers += 1
      if (row.status === 'failed' || row.status === 'blocked' || row.status === 'warning') failedTransfers += 1
    }
    return {
      securityEvents: logs.length,
      transferEvents,
      completedTransfers,
      failedTransfers,
    }
  }, [logs])

  const selectedCount = selected.size

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === logs.length) return new Set()
      return new Set(logs.map((r) => r.id))
    })
  }

  async function deleteOne(id) {
    try {
      await deleteSecurityLog(id)
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await refresh()
      showToast('success', 'Log deleted.')
    } catch (e) {
      showToast('error', e?.message || 'Delete failed')
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return
    if (!window.confirm(`Delete ${selected.size} selected logs?`)) return
    try {
      const out = await postSecurityLogsBulkDelete({ ids: Array.from(selected) })
      if (!out?.deleted) {
        showToast('error', 'No logs were deleted. Refresh and retry.')
        return
      }
      setSelected(new Set())
      await refresh()
      showToast('success', 'Selected logs deleted.')
    } catch (e) {
      showToast('error', e?.message || 'Bulk delete failed')
    }
  }

  async function deleteAll() {
    if (!logs.length) return
    if (!window.confirm('Delete ALL security logs? This does not affect subscriptions.')) return
    try {
      const out = await postSecurityLogsBulkDelete({ all: true })
      if (typeof out?.deleted === 'number' && out.deleted === 0 && logs.length > 0) {
        showToast('error', 'Delete-all completed with 0 rows affected.')
        return
      }
      setSelected(new Set())
      await refresh()
      showToast('success', 'All logs deleted.')
    } catch (e) {
      showToast('error', e?.message || 'Delete all failed')
    }
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-8">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Security Logs
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Full history of security and transfer events.
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
            <p className="mt-3 text-3xl font-bold tabular-nums text-amber-50">{stats.transferEvents}</p>
          </article>
          <article className="rounded-2xl border border-emerald-500/35 bg-emerald-950/25 p-5 ring-1 ring-emerald-500/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-300">Transfer Completed</p>
            <p className="mt-3 text-3xl font-bold tabular-nums text-emerald-100">{stats.completedTransfers}</p>
          </article>
          <article className="rounded-2xl border border-red-500/35 bg-red-950/25 p-5 ring-1 ring-red-500/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-red-300">Transfer Failed/Blocked</p>
            <p className="mt-3 text-3xl font-bold tabular-nums text-red-100">{stats.failedTransfers}</p>
          </article>
        </section>

        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="flex items-center gap-2 text-lg font-semibold text-white">
              <ClipboardList className="h-5 w-5 text-amber-400" />
              Event log
            </h2>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={toggleAll}
                className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
              >
                {selectedCount === logs.length && logs.length > 0 ? 'Unselect all' : 'Select all'}
              </button>
              <button
                type="button"
                disabled={selectedCount === 0}
                onClick={deleteSelected}
                className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete selected ({selectedCount})
              </button>
              <button
                type="button"
                disabled={logs.length === 0}
                onClick={deleteAll}
                className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 disabled:opacity-40"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete all
              </button>
            </div>
          </div>
          <ul className="space-y-3">
            {logs.map((row) => (
              <li
                key={row.id}
                className="rounded-2xl border border-slate-700/60 bg-slate-950/50 p-4 ring-1 ring-white/[0.04] transition-colors hover:border-slate-600/80"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleOne(row.id)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-amber-500 focus:ring-amber-500/40"
                      />
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
                    <button
                      type="button"
                      onClick={() => deleteOne(row.id)}
                      className="mt-2 inline-flex items-center gap-1 rounded-lg border border-red-500/35 bg-red-500/10 px-2.5 py-1 text-[11px] font-semibold text-red-200"
                    >
                      <Trash2 className="h-3 w-3" />
                      Delete
                    </button>
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
