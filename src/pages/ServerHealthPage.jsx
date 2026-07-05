import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getApiHealth, getServerHealth, syncStreamUrl } from '../lib/api'
import { shouldReplaceRows } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

function ServerHealthPage() {
  const { showToast } = useToast()
  const cached = readAdminSnapshot('server-health')
  const initialRows = Array.isArray(cached?.rows) ? cached.rows : []
  const [rows, setRows] = useState(initialRows)
  const rowsRef = useRef(initialRows)
  rowsRef.current = rows
  const loadGenRef = useRef(0)
  const [apiOk, setApiOk] = useState(cached?.apiOk ?? null)
  const [refreshing, setRefreshing] = useState(false)

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current
    try {
      const [health, probe] = await Promise.all([
        getApiHealth().catch(() => null),
        getServerHealth().catch(() => null),
      ])
      if (gen !== loadGenRef.current) return
      const nextOk = Boolean(health?.ok)
      setApiOk(nextOk)
      const ch = probe?.channels
      const next = Array.isArray(ch) ? ch : []
      if (shouldReplaceRows(rowsRef.current, next)) setRows(next)
      writeAdminSnapshot('server-health', { rows: next, apiOk: nextOk })
    } catch (e) {
      if (gen !== loadGenRef.current) return
      showToast('error', e?.message || 'Health check failed')
    }
  }, [showToast])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onChanged = () => {
      void load()
    }
    es.addEventListener('server_health_changed', onChanged)
    es.addEventListener('config.channels_changed', onChanged)
    return () => es.close()
  }, [load])

  const stats = useMemo(() => {
    const total = rows.length
    const online = rows.filter((r) => String(r.status || '').toLowerCase() === 'online').length
    const offline = total - online
    const latencies = rows
      .filter((r) => String(r.status || '').toLowerCase() === 'online' && Number(r.response_ms) > 0)
      .map((r) => Number(r.response_ms))
    const avg =
      latencies.length === 0 ? 0 : Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    return { total, online, offline, avg }
  }, [rows])

  const runRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await load()
    } finally {
      setRefreshing(false)
    }
  }, [load])

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">Server Health</h1>
            <p className="mt-1 text-sm text-slate-400">
              API {apiOk === null ? '…' : apiOk ? 'reachable' : 'unreachable'} · stream endpoints probed
              from channel list
            </p>
          </div>
          <button
            type="button"
            onClick={runRefresh}
            disabled={refreshing}
            className="inline-flex items-center justify-center gap-2 self-start rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-5 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:opacity-50"
          >
            {refreshing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </button>
        </header>

        <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-4 ring-1 ring-white/[0.04]">
            <p className="text-[11px] font-semibold uppercase text-slate-500">Total channels</p>
            <p className="mt-2 text-2xl font-bold text-white">{stats.total}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/30 p-4 ring-1 ring-emerald-500/20">
            <p className="text-[11px] font-semibold uppercase text-emerald-400/90">Online</p>
            <p className="mt-2 text-2xl font-bold text-emerald-100">{stats.online}</p>
          </div>
          <div className="rounded-2xl border border-red-500/30 bg-red-950/30 p-4 ring-1 ring-red-500/20">
            <p className="text-[11px] font-semibold uppercase text-red-400/90">Offline</p>
            <p className="mt-2 text-2xl font-bold text-red-100">{stats.offline}</p>
          </div>
          <div className="rounded-2xl border border-amber-500/30 bg-amber-950/25 p-4 ring-1 ring-amber-500/20">
            <p className="text-[11px] font-semibold uppercase text-amber-400/90">Avg response</p>
            <p className="mt-2 text-2xl font-bold text-white">{refreshing ? '…' : `${stats.avg} ms`}</p>
          </div>
        </section>

        <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700/80 bg-slate-900/60 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-semibold">Channel</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold">Response time</th>
                  <th className="px-4 py-3 font-semibold">Error</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr
                    key={`${r.name}:${r.status}:${r.response_ms ?? 0}:${r.error ?? ''}`}
                    className="border-b border-slate-800/80 hover:bg-slate-900/50"
                  >
                    <td className="px-4 py-3 font-medium text-slate-200">{r.name}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-lg px-2.5 py-0.5 text-[11px] font-bold uppercase ring-1 ${
                          String(r.status || '').toLowerCase() === 'online'
                            ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/45'
                            : 'bg-red-500/20 text-red-200 ring-red-400/45'
                        }`}
                      >
                        {String(r.status || '').toLowerCase() === 'online' ? 'Online' : 'Offline'}
                      </span>
                    </td>
                    <td className="px-4 py-3 tabular-nums text-slate-300">
                      {String(r.status || '').toLowerCase() === 'online' ? `${Number(r.response_ms) || 0} ms` : '—'}
                    </td>
                    <td className="max-w-[280px] truncate px-4 py-3 text-xs text-red-400/90">
                      {r.error || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </>
  )
}

export default ServerHealthPage
