import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Loader2, Search } from 'lucide-react'
import Topbar from './Topbar'
import { useDeviceIntelligenceRegistry } from '../hooks/useDeviceIntelligenceRegistry'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

const LIVE_POLL_MS = 15_000

function statusBadge(status) {
  const s = String(status || '').toLowerCase()
  if (s === 'blocked') return 'bg-red-500/20 text-red-200 ring-red-500/40'
  if (s === 'inactive') return 'bg-slate-500/20 text-slate-300 ring-slate-500/40'
  return 'bg-emerald-500/20 text-emerald-200 ring-emerald-500/40'
}

function CounterCard({ label, value, tone }) {
  const tones = {
    default: 'border-slate-700/60 bg-slate-900/50',
    active: 'border-emerald-500/30 bg-emerald-950/20',
    blocked: 'border-red-500/30 bg-red-950/20',
    inactive: 'border-slate-600/40 bg-slate-900/30',
  }
  return (
    <div className={`rounded-2xl border p-4 ${tones[tone] || tones.default}`}>
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className="mt-2 text-3xl font-bold text-white">{value ?? 0}</p>
    </div>
  )
}

const STATUS_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'inactive', label: 'Inactive' },
]

/**
 * Shared Users Intelligence / Device Registry UI.
 * @param {{
 *   title: string,
 *   description: string,
 *   icon: import('lucide-react').LucideIcon,
 *   showStatusFilter?: boolean,
 *   totalLabel?: string,
 *   totalOverride?: number | null,
 * }} props
 */
export default function DeviceIntelligenceRegistryView({
  title,
  description,
  icon: Icon,
  showStatusFilter = false,
  totalLabel = 'Total devices ever seen',
  totalOverride = null,
}) {
  const navigate = useNavigate()
  const [statusFilter, setStatusFilter] = useState('all')
  const {
    loading,
    items,
    summary,
    search,
    setSearch,
    query,
    handleSearch,
    clearSearch,
  } = useDeviceIntelligenceRegistry({
    pollMs: LIVE_POLL_MS,
    statusFilter: showStatusFilter ? statusFilter : 'all',
  })

  const overrideTotal = Number(totalOverride)
  const hasTotalOverride = totalOverride != null && Number.isFinite(overrideTotal) && overrideTotal >= 0
  const totalValue = hasTotalOverride ? overrideTotal : summary?.totalDevicesEverSeen
  const showCounters = summary || hasTotalOverride

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2 text-amber-400">
              <Icon className="h-6 w-6" aria-hidden />
              <h1 className="text-2xl font-bold text-white">{title}</h1>
            </div>
            <p className="mt-1 text-sm text-slate-400">{description}</p>
          </div>
        </div>

        {showCounters ? (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <CounterCard label={totalLabel} value={totalValue ?? 0} />
            <CounterCard label="Active devices" value={summary?.activeDevices} tone="active" />
            <CounterCard label="Blocked devices" value={summary?.blockedDevices} tone="blocked" />
            <CounterCard label="Inactive devices" value={summary?.inactiveDevices} tone="inactive" />
          </div>
        ) : null}

        <form onSubmit={handleSearch} className="flex flex-wrap gap-2">
          <div className="relative min-w-[240px] flex-1">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Phone, Account ID, or Device ID"
              className="w-full rounded-xl border border-slate-600/60 bg-[#0a0e16] py-3 pl-10 pr-4 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/50 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
            />
          </div>
          <button
            type="submit"
            className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-5 py-3 text-sm font-semibold text-slate-950 hover:opacity-95"
          >
            Search
          </button>
          {query ? (
            <button
              type="button"
              className="rounded-xl border border-slate-600 px-4 py-3 text-sm text-slate-300 hover:bg-slate-800"
              onClick={clearSearch}
            >
              Clear
            </button>
          ) : null}
        </form>

        {showStatusFilter ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label="Status filter">
            {STATUS_FILTERS.map((f) => {
              const active = statusFilter === f.id
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => setStatusFilter(f.id)}
                  className={
                    active
                      ? 'rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-4 py-2 text-sm font-semibold text-slate-950'
                      : 'rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800'
                  }
                >
                  {f.label}
                </button>
              )
            })}
          </div>
        ) : null}

        <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-900/40">
          {loading ? (
            <div className="flex items-center justify-center gap-2 p-12 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin" />
              Loading registry…
            </div>
          ) : items.length === 0 ? (
            <p className="p-8 text-center text-sm text-slate-400">No devices found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/80 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-semibold">Device ID</th>
                    <th className="px-4 py-3 font-semibold">Account / Phone</th>
                    <th className="px-4 py-3 font-semibold">Model</th>
                    <th className="px-4 py-3 font-semibold">App</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((row) => (
                    <tr
                      key={row.id}
                      className="cursor-pointer border-b border-slate-800/80 transition-colors hover:bg-slate-800/50"
                      onClick={() => navigate(`/users-intelligence/${row.id}`)}
                    >
                      <td className="max-w-[200px] truncate px-4 py-3 font-mono text-xs text-amber-100/90">
                        {row.deviceId}
                      </td>
                      <td className="px-4 py-3 text-slate-200">
                        <div>{row.phoneNumber || row.accountId || '—'}</div>
                        <div className="text-xs text-slate-500">{row.accountId}</div>
                      </td>
                      <td className="px-4 py-3 text-slate-300">
                        {[row.deviceBrand, row.deviceModel].filter(Boolean).join(' ') || '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-400">{row.appVersion || '—'}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold capitalize ring-1 ${statusBadge(row.status)}`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-400">
                        {formatAdminDateTime(row.lastSeenAt)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </main>
    </>
  )
}
