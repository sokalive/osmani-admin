import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { Loader2, RefreshCw, Search, Shield, ShieldAlert, Trash2 } from 'lucide-react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import Topbar from '../components/Topbar'
import SecurityPinModal from '../components/SecurityPinModal'
import { useToast } from '../context/ToastContext.jsx'
import {
  deleteSecurityAlert,
  deleteSecurityLog,
  getSecurityLogs,
  getSecurityRiskDevices,
  getSecurityStats,
  getSecuritySuite,
  postSecurityDevicesBulkAction,
  postSecurityLogsBulkDelete,
  postVerifyAdminSecurityPin,
  putSecuritySuite,
  syncStreamUrl,
} from '../lib/api'
import { formatReadableDateTime } from '../lib/formatTxDisplay'
import { levelBadgeClass } from '../lib/securityLevels'

const TABS = [
  { id: 'alerts', label: 'Security Alerts' },
  { id: 'risk', label: 'Risk Devices' },
  { id: 'logs', label: 'Security Logs' },
]

function ConfirmModal({ open, title, message, confirmLabel, loading, onConfirm, onCancel }) {
  if (!open) return null
  return (
      <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
        <button
          type="button"
          className="absolute inset-0 bg-black/80 backdrop-blur-sm"
          aria-label="Close"
          onClick={loading ? undefined : onCancel}
        />
        <div
          className="relative w-full max-w-md rounded-2xl border border-slate-600/60 bg-[#0b1220] p-6 shadow-2xl ring-1 ring-cyan-500/20"
          role="dialog"
          aria-modal="true"
        >
          <h2 className="text-lg font-bold text-white">{title}</h2>
          <p className="mt-2 text-sm text-slate-400">{message}</p>
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  disabled={loading}
                  onClick={onCancel}
                  className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={onConfirm}
                  className="inline-flex items-center gap-2 rounded-xl bg-cyan-500/20 px-4 py-2 text-sm font-semibold text-cyan-100 ring-1 ring-cyan-500/40 hover:bg-cyan-500/30 disabled:opacity-50"
                >
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  {confirmLabel}
                </button>
              </div>
        </div>
      </div>
  )
}

function LevelBadge({ level }) {
  return (
    <span
      className={`inline-flex rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ring-1 ${levelBadgeClass(level)}`}
    >
      {level || 'warning'}
    </span>
  )
}

function FlagCell({ value }) {
  return (
    <span className={value ? 'font-semibold text-red-400' : 'text-slate-600'}>
      {value ? 'Yes' : '—'}
    </span>
  )
}

function pathToTab(pathname) {
  if (pathname.includes('security-risk')) return 'risk'
  if (pathname.includes('security-logs')) return 'logs'
  if (pathname.includes('security-alerts')) return 'alerts'
  return null
}

function SecurityDashboardPage() {
  const { showToast } = useToast()
  const navigate = useNavigate()
  const location = useLocation()
  const [searchParams, setSearchParams] = useSearchParams()
  const [pageUnlocked, setPageUnlocked] = useState(false)
  const [pinError, setPinError] = useState('')
  const [pinBusy, setPinBusy] = useState(false)
  const pathTab = pathToTab(location.pathname)
  const queryTab = searchParams.get('tab')
  const tab =
    TABS.some((t) => t.id === queryTab) ? queryTab : pathTab && TABS.some((t) => t.id === pathTab) ? pathTab : 'alerts'

  const [loading, setLoading] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [stats, setStats] = useState({ byLevel: {}, total: 0, flagged24h: 0 })
  const [alerts, setAlerts] = useState([])
  const [devices, setDevices] = useState([])
  const [logs, setLogs] = useState([])
  const [protectionMode, setProtectionMode] = useState('manual')
  const [search, setSearch] = useState('')
  const [levelFilter, setLevelFilter] = useState('')
  const [selectedDevices, setSelectedDevices] = useState(() => new Set())
  const [selectedLogs, setSelectedLogs] = useState(() => new Set())
  const [confirm, setConfirm] = useState(null)

  const setTab = (id) => {
    if (location.pathname !== '/security') {
      navigate(`/security?tab=${encodeURIComponent(id)}`, { replace: true })
      return
    }
    setSearchParams({ tab: id })
  }

  useEffect(() => {
    setPageUnlocked(false)
    setPinError('')
  }, [location.pathname])

  async function handleGatePinSubmit(pin) {
    setPinBusy(true)
    setPinError('')
    try {
      await postVerifyAdminSecurityPin(pin)
      setPageUnlocked(true)
      showToast('success', 'Security Center unlocked')
    } catch (e) {
      setPinError(e?.message || 'Incorrect PIN')
      showToast('error', e?.message || 'Incorrect PIN')
    } finally {
      setPinBusy(false)
    }
  }

  function handleGateClose() {
    if (pinBusy) return
    navigate('/', { replace: true })
  }

  const loadAll = useCallback(async () => {
    setLoading(true)
    try {
      const [suite, riskRes, logsRes, statsRes] = await Promise.all([
        getSecuritySuite(),
        getSecurityRiskDevices({ q: search || undefined, level: levelFilter || undefined }),
        getSecurityLogs(),
        getSecurityStats(),
      ])
      setAlerts(Array.isArray(suite?.alerts) ? suite.alerts : [])
      setProtectionMode(suite?.protectionMode === 'automatic' ? 'automatic' : 'manual')
      setDevices(Array.isArray(riskRes?.devices) ? riskRes.devices : [])
      setLogs(Array.isArray(logsRes) ? logsRes : [])
      setStats(statsRes || { byLevel: {}, total: 0, flagged24h: 0 })
    } catch (e) {
      showToast('error', e?.message || 'Failed to load security dashboard')
    } finally {
      setLoading(false)
    }
  }, [levelFilter, search, showToast])

  useEffect(() => {
    if (!pageUnlocked) return
    void loadAll()
  }, [loadAll, pageUnlocked])

  useEffect(() => {
    if (!pageUnlocked) return undefined
    const es = new EventSource(syncStreamUrl(['config']))
    const refresh = () => void loadAll()
    ;[
      'security_detection_new',
      'security_device_changed',
      'security_admin_action',
      'security_alerts_changed',
      'security_logs_changed',
      'security_event_logged',
    ].forEach((ev) => es.addEventListener(ev, refresh))
    return () => es.close()
  }, [loadAll, pageUnlocked])

  const chartData = useMemo(
    () =>
      ['warning', 'limited', 'blocked', 'critical'].map((k) => ({
        level: k,
        count: Number(stats.byLevel?.[k]) || 0,
      })),
    [stats.byLevel],
  )

  const filteredAlerts = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return alerts
    return alerts.filter(
      (a) =>
        String(a.actor || '').toLowerCase().includes(q) ||
        String(a.title || '').toLowerCase().includes(q) ||
        String(a.deviceOrIp || '').toLowerCase().includes(q),
    )
  }, [alerts, search])

  const runBulk = useCallback(
    async (action) => {
      const ids = Array.from(selectedDevices)
      if (!ids.length) return
      setActionLoading(true)
      try {
        await postSecurityDevicesBulkAction({ action, device_ids: ids })
        setSelectedDevices(new Set())
        showToast('success', `Bulk ${action} on ${ids.length} device(s)`)
        await loadAll()
      } catch (e) {
        showToast('error', e?.message || 'Bulk action failed')
      } finally {
        setActionLoading(false)
      }
    },
    [loadAll, selectedDevices, showToast],
  )

  async function saveProtectionMode(mode) {
    try {
      const suite = await getSecuritySuite()
      await putSecuritySuite({
        protectionMode: mode,
        whitelist: suite?.whitelist ?? [],
        blockedUsers: suite?.blockedUsers ?? [],
        alerts: suite?.alerts ?? alerts,
      })
      setProtectionMode(mode)
      showToast('success', `Protection mode: ${mode}`)
      await loadAll()
    } catch (e) {
      showToast('error', e?.message || 'Save failed')
    }
  }

  function toggleDevice(id) {
    setSelectedDevices((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllDevices() {
    setSelectedDevices((prev) =>
      prev.size === devices.length ? new Set() : new Set(devices.map((d) => d.device_id)),
    )
  }

  if (!pageUnlocked) {
    return (
      <>
        <Topbar />
        <main className="mt-6 flex min-h-[50vh] flex-1 flex-col items-center justify-center gap-4 px-4">
          <Shield className="h-12 w-12 text-cyan-500/60" />
          <p className="text-center text-sm text-slate-400">
            Enter the security PIN to open the anti-tamper dashboard.
          </p>
        </main>
        <SecurityPinModal
          open
          title="Enter Security PIN"
          submitLabel="Unlock"
          errorText={pinError}
          busy={pinBusy}
          onClose={handleGateClose}
          onSubmit={handleGatePinSubmit}
        />
      </>
    )
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="flex items-center gap-2 text-cyan-400">
              <Shield className="h-6 w-6" />
              <span className="text-xs font-bold uppercase tracking-widest">Anti-Tamper</span>
            </div>
            <h1 className="mt-1 text-2xl font-bold text-white sm:text-3xl">Security Center</h1>
            <p className="mt-1 text-sm text-slate-400">
              Strict enforcement: any root, emulator, clone, debugger, Frida, or tampered APK report
              blocks playback immediately until you whitelist or reset the device.
            </p>
          </div>
          <button
            type="button"
            onClick={() => loadAll()}
            disabled={loading}
            className="inline-flex items-center gap-2 self-start rounded-xl border border-slate-600 bg-slate-900/80 px-4 py-2 text-sm text-slate-200 hover:border-cyan-500/40"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </header>

        <section className="grid gap-4 lg:grid-cols-4">
          {[
            { label: 'Risk devices', value: stats.total, sub: 'tracked profiles' },
            { label: 'Flagged 24h', value: stats.flagged24h, sub: 'recent signals' },
            { label: 'Active alerts', value: filteredAlerts.length, sub: 'needs review' },
            { label: 'Audit logs', value: logs.length, sub: 'events stored' },
          ].map((c) => (
            <div
              key={c.label}
              className="rounded-2xl border border-slate-700/50 bg-gradient-to-br from-slate-900/90 to-slate-950/90 p-4 ring-1 ring-white/[0.03]"
            >
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{c.label}</p>
              <p className="mt-2 text-3xl font-bold text-white">{c.value}</p>
              <p className="text-xs text-slate-500">{c.sub}</p>
            </div>
          ))}
        </section>

        <section className="grid gap-4 lg:grid-cols-3">
          <div className="rounded-2xl border border-slate-700/50 bg-slate-950/50 p-4 lg:col-span-2">
            <p className="mb-3 text-xs font-semibold uppercase text-slate-500">Risk by level</p>
            <div className="h-48">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={chartData}>
                  <CartesianGrid stroke="#334155" strokeDasharray="3 3" vertical={false} />
                  <XAxis dataKey="level" tick={{ fill: '#94a3b8', fontSize: 11 }} />
                  <YAxis allowDecimals={false} tick={{ fill: '#94a3b8', fontSize: 11 }} />
                  <Tooltip
                    contentStyle={{
                      background: '#0f172a',
                      border: '1px solid #475569',
                      borderRadius: 12,
                    }}
                  />
                  <Bar dataKey="count" fill="#22d3ee" radius={[6, 6, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-2xl border border-slate-700/50 bg-slate-950/50 p-4">
            <p className="text-xs font-semibold uppercase text-slate-500">Protection mode</p>
            <p className="mt-2 text-sm text-slate-400">
              <strong className="text-cyan-200">Automatic</strong> = strict enforcement (any signal →
              blocked). Manual = monitor only (no auto-block on new reports).
            </p>
            <div className="mt-4 flex gap-2">
              {[
                { id: 'automatic', label: 'Strict (auto)' },
                { id: 'manual', label: 'Monitor only' },
              ].map(({ id, label }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => saveProtectionMode(id)}
                  className={`flex-1 rounded-xl py-2 text-xs font-bold uppercase ${
                    protectionMode === id
                      ? 'bg-cyan-500/25 text-cyan-100 ring-1 ring-cyan-400/50'
                      : 'border border-slate-600 text-slate-400'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>

          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex flex-wrap gap-1 rounded-2xl border border-slate-700/60 bg-slate-950/60 p-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setTab(t.id)}
                  className={`rounded-xl px-4 py-2 text-sm font-medium transition-colors ${
                    tab === t.id
                      ? 'bg-cyan-500/20 text-cyan-100 ring-1 ring-cyan-500/40'
                      : 'text-slate-400 hover:text-white'
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="relative min-w-[200px] flex-1 sm:max-w-xs">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search device, phone, risk…"
                className="w-full rounded-xl border border-slate-600/70 bg-slate-900/80 py-2.5 pl-10 pr-3 text-sm text-white focus:border-cyan-500/50 focus:outline-none"
              />
            </div>
          </div>

        {tab === 'risk' && (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={levelFilter}
                onChange={(e) => setLevelFilter(e.target.value)}
                className="rounded-xl border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-200"
              >
                <option value="">All levels</option>
                <option value="warning">Warning</option>
                <option value="limited">Limited</option>
                <option value="blocked">Blocked</option>
                <option value="critical">Critical</option>
              </select>
              <button
                type="button"
                disabled={!selectedDevices.size || actionLoading}
                onClick={() =>
                  setConfirm({
                    title: 'Block selected',
                    message: `Temporarily block ${selectedDevices.size} device(s)?`,
                    action: () => runBulk('temporary_block'),
                  })
                }
                className="rounded-xl border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200 disabled:opacity-40"
              >
                Block selected
              </button>
              <button
                type="button"
                disabled={!selectedDevices.size || actionLoading}
                onClick={() => runBulk('whitelist')}
                className="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-xs font-semibold text-emerald-200 disabled:opacity-40"
              >
                Whitelist selected
              </button>
            </div>

            <div className="overflow-x-auto rounded-2xl border border-slate-700/50 bg-slate-950/40">
              <table className="w-full min-w-[1100px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/60 text-xs uppercase text-slate-500">
                    <th className="p-3">
                      <input
                        type="checkbox"
                        checked={devices.length > 0 && selectedDevices.size === devices.length}
                        onChange={toggleAllDevices}
                      />
                    </th>
                    <th className="p-3">Device ID</th>
                    <th className="p-3">Phone number</th>
                    <th className="p-3">Risk reason</th>
                    <th className="p-3">Detection time</th>
                    <th className="p-3">App</th>
                    <th className="p-3">Score</th>
                    <th className="p-3">Root</th>
                    <th className="p-3">Emu</th>
                    <th className="p-3">Clone</th>
                    <th className="p-3">Dbg</th>
                    <th className="p-3">Frida</th>
                    <th className="p-3">APK</th>
                    <th className="p-3">Last seen</th>
                    <th className="p-3">Level</th>
                    <th className="p-3">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {devices.map((d) => (
                    <tr
                      key={d.device_id}
                      className="cursor-pointer border-b border-slate-800/60 hover:bg-slate-900/50"
                      onClick={() =>
                        navigate(
                          `/security-risk/${encodeURIComponent(d.device_id)}/investigation`,
                        )
                      }
                    >
                      <td className="p-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedDevices.has(d.device_id)}
                          onChange={() => toggleDevice(d.device_id)}
                        />
                      </td>
                      <td className="max-w-[180px] p-3 font-mono text-xs text-cyan-100" title={d.device_id}>
                        {d.device_id}
                      </td>
                      <td className="max-w-[120px] p-3 text-sm text-white">{d.phone_user || d.phone || '—'}</td>
                      <td className="max-w-[140px] p-3 text-slate-300">{d.risk_reason || d.risk_type || '—'}</td>
                      <td className="p-3 text-xs text-slate-400">
                        {formatReadableDateTime(d.detection_time || d.first_seen || d.last_seen)}
                      </td>
                      <td className="p-3 text-slate-400">{d.app_version || '—'}</td>
                      <td className="p-3 font-semibold text-white">{d.risk_score}</td>
                      <td className="p-3">
                        <FlagCell value={d.rooted} />
                      </td>
                      <td className="p-3">
                        <FlagCell value={d.emulator} />
                      </td>
                      <td className="p-3">
                        <FlagCell value={d.clone_detected} />
                      </td>
                      <td className="p-3">
                        <FlagCell value={d.debugger} />
                      </td>
                      <td className="p-3">
                        <FlagCell value={d.frida} />
                      </td>
                      <td className="p-3">
                        <FlagCell value={d.tampered_apk} />
                      </td>
                      <td className="p-3">
                        <LevelBadge level={d.security_level} />
                      </td>
                      <td className="p-3 text-xs capitalize text-slate-400">{d.status}</td>
                    </tr>
                  ))}
                  {!devices.length && !loading && (
                    <tr>
                      <td colSpan={15} className="p-8 text-center text-slate-500">
                        No risk devices yet. Reports appear when the app sends runtime security scans.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}

        {tab === 'alerts' && (
          <div className="space-y-2">
            {filteredAlerts.map((a) => (
              <div
                key={a.id}
                className="flex flex-col gap-3 rounded-2xl border border-slate-700/50 bg-slate-950/50 p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                  <div>
                      <div className="flex items-center gap-2">
                        <ShieldAlert className="h-4 w-4 text-amber-400" />
                        <span className="font-medium text-white">{a.title}</span>
                        <span className="rounded-lg bg-amber-500/15 px-2 py-0.5 text-[10px] font-bold uppercase text-amber-200">
                          {a.status}
                        </span>
                      </div>
                    <p className="mt-1 font-mono text-xs text-slate-400">{a.actor || '—'}</p>
                    <p className="text-xs text-slate-500">{a.deviceOrIp}</p>
                    <p className="text-xs text-slate-600">
                      {formatReadableDateTime(a.timestamp || a.time)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={async () => {
                      try {
                        await deleteSecurityAlert(a.id)
                        await loadAll()
                      } catch (e) {
                        showToast('error', e?.message || 'Delete failed')
                      }
                    }}
                    className="self-start rounded-lg p-2 text-slate-500 hover:bg-red-500/10 hover:text-red-300"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
              </div>
            ))}
            {!filteredAlerts.length && (
              <p className="py-12 text-center text-slate-500">No active security alerts.</p>
            )}
          </div>
        )}

        {tab === 'logs' && (
          <>
            <div className="mb-3 flex gap-2">
              <button
                type="button"
                disabled={!selectedLogs.size}
                onClick={() =>
                  setConfirm({
                    title: 'Delete logs',
                    message: `Delete ${selectedLogs.size} selected log(s)?`,
                    action: async () => {
                      await postSecurityLogsBulkDelete({ ids: Array.from(selectedLogs) })
                      setSelectedLogs(new Set())
                      await loadAll()
                    },
                  })
                }
                className="rounded-xl border border-red-500/40 px-3 py-2 text-xs text-red-200 disabled:opacity-40"
              >
                Delete selected
              </button>
            </div>
            <div className="overflow-x-auto rounded-2xl border border-slate-700/50">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700 text-xs uppercase text-slate-500">
                    <th className="w-10 p-3" />
                    <th className="p-3">Time</th>
                    <th className="p-3">Actor</th>
                    <th className="p-3">Event</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Detail</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody>
                  {logs.map((row) => (
                    <tr key={row.id} className="border-b border-slate-800/60">
                      <td className="p-3">
                        <input
                          type="checkbox"
                          checked={selectedLogs.has(row.id)}
                          onChange={() => {
                            setSelectedLogs((prev) => {
                              const next = new Set(prev)
                              if (next.has(row.id)) next.delete(row.id)
                              else next.add(row.id)
                              return next
                            })
                          }}
                        />
                      </td>
                      <td className="p-3 text-xs text-slate-500">
                        {formatReadableDateTime(row.timestamp)}
                      </td>
                      <td className="p-3 font-mono text-xs">{row.actor}</td>
                      <td className="p-3">{row.eventType}</td>
                      <td className="p-3">{row.status}</td>
                      <td className="max-w-md truncate p-3 text-slate-400">{row.detail}</td>
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={async () => {
                            await deleteSecurityLog(row.id)
                            await loadAll()
                          }}
                          className="text-slate-500 hover:text-red-400"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>

      <ConfirmModal
        open={Boolean(confirm)}
        title={confirm?.title}
        message={confirm?.message}
        confirmLabel="Confirm"
        loading={actionLoading}
        onCancel={() => setConfirm(null)}
        onConfirm={async () => {
          if (confirm?.action) await confirm.action()
          setConfirm(null)
        }}
      />
    </>
  )
}

export default SecurityDashboardPage
