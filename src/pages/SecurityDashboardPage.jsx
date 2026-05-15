import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Loader2,
  RefreshCw,
  Search,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Trash2,
  X,
} from 'lucide-react'
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
  postSecurityDeviceAction,
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

function DeviceDetailModal({ device, loading, onClose, onAction }) {
  if (!device) return null
  const actions = [
    { id: 'allow_device', label: 'Allow Device', icon: CheckCircle2 },
    { id: 'whitelist', label: 'Whitelist', icon: ShieldCheck },
    { id: 'remove_restriction', label: 'Remove Restriction', icon: RefreshCw },
    { id: 'temporary_block', label: 'Temporary Block', icon: Ban },
    { id: 'permanent_block', label: 'Permanent Block', icon: Ban },
    { id: 'reset_risk', label: 'Reset Risk', icon: RefreshCw },
    { id: 'force_logout', label: 'Force Logout', icon: AlertTriangle },
  ]
  return (
    <div className="fixed inset-0 z-[115] flex items-end justify-center p-4 sm:items-center">
      <button type="button" className="absolute inset-0 bg-black/80" aria-label="Close" onClick={onClose} />
        <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl border border-slate-600/60 bg-[#0b1220] p-6 shadow-2xl ring-1 ring-cyan-500/15">
          <div className="flex items-start justify-between gap-4">
            <div>
              <h2 className="text-xl font-bold text-white">Device security</h2>
              <p className="mt-1 break-all font-mono text-xs text-slate-400">{device.device_id}</p>
            </div>
            <button type="button" onClick={onClose} className="rounded-lg p-2 text-slate-400 hover:bg-slate-800">
              <X className="h-5 w-5" />
            </button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-slate-700/50 bg-slate-900/50 p-3">
              <p className="text-[10px] uppercase text-slate-500">Risk score</p>
              <p className="text-2xl font-bold text-white">{device.risk_score}</p>
              <LevelBadge level={device.security_level} />
            </div>
              <div className="rounded-xl border border-slate-700/50 bg-slate-900/50 p-3">
                <p className="text-[10px] uppercase text-slate-500">Status</p>
                <p className="text-sm font-medium text-slate-200">{device.status}</p>
                <p className="mt-1 text-xs text-slate-500">{device.risk_type || '—'}</p>
              </div>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
            {[
              ['Root', device.rooted],
              ['Emulator', device.emulator],
              ['Clone', device.clone_detected],
              ['Debugger', device.debugger],
              ['Frida', device.frida],
              ['Tampered', device.tampered_apk],
            ].map(([label, v]) => (
              <div key={label} className="rounded-lg border border-slate-700/40 bg-slate-900/40 py-2">
                <p className="text-slate-500">{label}</p>
                <FlagCell value={v} />
              </div>
            ))}
          </div>
          <p className="mt-4 text-xs text-slate-500">
            Last seen: {formatReadableDateTime(device.last_seen)}
          </p>
          <div className="mt-5 flex flex-wrap gap-2">
            {actions.map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                type="button"
                disabled={loading}
                onClick={() => onAction(id)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2 text-xs font-medium text-slate-200 hover:border-cyan-500/40 hover:text-white disabled:opacity-50"
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </button>
            ))}
          </div>
        </div>
    </div>
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
  const [detailDevice, setDetailDevice] = useState(null)
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

  const runDeviceAction = useCallback(
    async (deviceId, action) => {
      setActionLoading(true)
      try {
        const res = await postSecurityDeviceAction(deviceId, { action })
        if (res?.device) setDetailDevice(res.device)
        showToast('success', `Action applied: ${action.replace(/_/g, ' ')}`)
        await loadAll()
      } catch (e) {
        showToast('error', e?.message || 'Action failed')
      } finally {
        setActionLoading(false)
      }
    },
    [loadAll, showToast],
  )

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
              Runtime integrity reports, risk scoring, and admin overrides. Rooted devices are never
              auto-banned without your action.
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
              Manual = warnings only until you block. Automatic escalates by score (root alone stays
              warning).
            </p>
            <div className="mt-4 flex gap-2">
              {['manual', 'automatic'].map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => saveProtectionMode(m)}
                  className={`flex-1 rounded-xl py-2 text-xs font-bold uppercase ${
                    protectionMode === m
                      ? 'bg-cyan-500/25 text-cyan-100 ring-1 ring-cyan-400/50'
                      : 'border border-slate-600 text-slate-400'
                  }`}
                >
                  {m}
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
                    <th className="p-3">Device</th>
                    <th className="p-3">Phone</th>
                    <th className="p-3">App</th>
                    <th className="p-3">Risk</th>
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
                      onClick={() => setDetailDevice(d)}
                    >
                      <td className="p-3" onClick={(e) => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={selectedDevices.has(d.device_id)}
                          onChange={() => toggleDevice(d.device_id)}
                        />
                      </td>
                      <td className="max-w-[140px] truncate p-3 font-mono text-xs text-slate-300">
                        {d.device_id}
                      </td>
                      <td className="p-3 text-slate-400">{d.phone_user || '—'}</td>
                      <td className="p-3 text-slate-400">{d.app_version || '—'}</td>
                      <td className="p-3 text-slate-400">{d.risk_type || '—'}</td>
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
                      <td className="p-3 text-xs text-slate-500">
                        {formatReadableDateTime(d.last_seen)}
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

      <DeviceDetailModal
        device={detailDevice}
        loading={actionLoading}
        onClose={() => setDetailDevice(null)}
        onAction={(action) => {
          if (!detailDevice?.device_id) return
          if (action === 'permanent_block' || action === 'temporary_block') {
            setConfirm({
              title: action === 'permanent_block' ? 'Permanent block' : 'Temporary block',
              message: `Apply ${action.replace(/_/g, ' ')} to ${detailDevice.device_id}?`,
              action: () => runDeviceAction(detailDevice.device_id, action),
            })
            return
          }
          void runDeviceAction(detailDevice.device_id, action)
        }}
      />

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
