import { useCallback, useEffect, useMemo, useRef, useState, Component } from 'react'
import { Loader2, Pencil, Trash2 } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import SubscriptionEditModal from '../components/SubscriptionEditModal'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  deleteUser,
  deleteUsersBulk,
  getPlans,
  getUsers,
  getUsersActive,
  getUsersExpiring,
  getUsersFailedPayments,
  getUsersSummary,
  putUser,
  syncStreamUrl,
} from '../lib/api'
import { formatAdminDateTime, formatAdminRemainingFromExpiry } from '../lib/formatAdminDateTime'
import { formatTsh } from '../lib/formatMoney'

const PAGE_SIZE = 25

const TABS = [
  { id: 'active_paid', label: 'Active Paid', countKey: 'active_paid' },
  { id: 'expiring', label: 'Expiring Soon', countKey: 'expiring_7d' },
  { id: 'failed', label: 'Failed Payments', countKey: 'failed_payments' },
  { id: 'all', label: 'All Subscriptions', countKey: 'all_subscriptions' },
]

const EXPIRING_FILTERS = [
  { id: '24h', label: '24 hours', within: '24h', countKey: 'expiring_24h' },
  { id: '3d', label: '3 days', within: '3d', countKey: 'expiring_3d' },
  { id: '7d', label: '7 days', within: '7d', countKey: 'expiring_7d' },
]

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/60 bg-[#0a0e16] px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#f5b301]/50 focus:outline-none focus:ring-2 focus:ring-[#f5b301]/20'
}

function labelClass() {
  return 'mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function statusBadgeClass(status) {
  if (status === 'active') return 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
  if (status === 'failed') return 'bg-red-500/20 text-red-200 ring-red-400/40'
  if (status === 'pending') return 'bg-amber-500/20 text-amber-200 ring-amber-400/40'
  return 'bg-red-500/20 text-red-200 ring-red-400/40'
}

function TableSkeleton({ cols = 8, rows = 6 }) {
  return (
    <tbody>
      {Array.from({ length: rows }).map((_, i) => (
        <tr key={i} className="border-b border-slate-800/80">
          {Array.from({ length: cols }).map((__, j) => (
            <td key={j} className="px-4 py-3">
              <div className="h-4 animate-pulse rounded bg-slate-800/80" />
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  )
}

function ConfirmModal({ open, title, message, confirmLabel, loading, onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={loading ? undefined : onCancel}
      />
      <div
        className="relative w-full max-w-md rounded-2xl border border-slate-600/50 bg-[#0f172a] p-6 shadow-2xl ring-1 ring-red-500/20"
        role="dialog"
        aria-modal="true"
      >
        <h2 className="text-lg font-bold text-white">{title}</h2>
        <p className="mt-2 text-sm leading-relaxed text-slate-400">{message}</p>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          <button
            type="button"
            disabled={loading}
            onClick={onCancel}
            className="rounded-xl border border-slate-600 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={loading}
            onClick={onConfirm}
            className="inline-flex items-center gap-2 rounded-xl border border-red-500/50 bg-red-500/15 px-5 py-2.5 text-sm font-semibold text-red-200 hover:bg-red-500/25 disabled:opacity-50"
          >
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

class UsersPageErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[UsersPage] render error', error?.message || error, info?.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <>
          <Topbar />
          <main className="mt-6 flex min-h-0 flex-1 flex-col gap-4 px-4">
            <div className="rounded-2xl border border-red-500/40 bg-red-950/30 p-6 text-red-100">
              <h1 className="text-lg font-bold text-white">Users page failed to load</h1>
              <p className="mt-2 text-sm text-red-200/90">
                {String(this.state.error?.message || this.state.error || 'Unknown error')}
              </p>
              <button
                type="button"
                className="mt-4 rounded-xl bg-slate-800 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-700"
                onClick={() => this.setState({ error: null })}
              >
                Try again
              </button>
            </div>
          </main>
        </>
      )
    }
    return this.props.children
  }
}

function PaginationBar({ page, totalPages, total, onPageChange, disabled }) {
  if (totalPages <= 1) return null
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 px-4 py-3 text-sm text-slate-400">
      <span>
        Page {page} of {totalPages}
        <span className="ml-2 text-slate-500">({total} total)</span>
      </span>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={disabled || page <= 1}
          onClick={() => onPageChange(page - 1)}
          className="rounded-lg border border-slate-600 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
        >
          Previous
        </button>
        <button
          type="button"
          disabled={disabled || page >= totalPages}
          onClick={() => onPageChange(page + 1)}
          className="rounded-lg border border-slate-600 px-3 py-1.5 hover:bg-slate-800 disabled:opacity-40"
        >
          Next
        </button>
      </div>
    </div>
  )
}

function UsersPageContent() {
  const { showToast } = useToast()
  const [tab, setTab] = useState('active_paid')
  const [expiringWithin, setExpiringWithin] = useState('7d')
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [searchDebounced, setSearchDebounced] = useState('')
  const [items, setItems] = useState([])
  const [pagination, setPagination] = useState({ page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 })
  const [summary, setSummary] = useState(null)
  const [plans, setPlans] = useState([])
  const [editing, setEditing] = useState(null)
  const [flash, setFlash] = useState(null)
  const [tableLoading, setTableLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const [remainingClock, setRemainingClock] = useState(0)
  const loadedTabsRef = useRef(new Set())
  const loadTabGenRef = useRef(0)
  const loadSummaryGenRef = useRef(0)
  const sseRefreshTimerRef = useRef(null)
  const fetchAbortRef = useRef(null)
  const hasTableDataRef = useRef(false)
  const pageRef = useRef(page)
  pageRef.current = page

  useEffect(() => {
    const t = window.setTimeout(() => setSearchDebounced(search.trim()), 300)
    return () => window.clearTimeout(t)
  }, [search])

  useEffect(() => {
    setPage(1)
    setSelected(new Set())
    hasTableDataRef.current = false
  }, [tab, expiringWithin, searchDebounced])

  const planMap = useMemo(() => {
    const m = new Map()
    plans.forEach((p) => m.set(Number(p.id), p.name))
    return m
  }, [plans])

  const fetchTab = useCallback(
    async (opts = {}, signal) => {
      const params = {
        page: opts.page ?? page,
        limit: PAGE_SIZE,
        search: searchDebounced || undefined,
        sort: tab === 'expiring' || tab === 'active_paid' ? 'expiry_soonest' : 'newest',
      }
      if (tab === 'expiring') params.within = expiringWithin
      const reqOpts = signal ? { signal } : {}
      let res
      if (tab === 'active_paid') res = await getUsersActive(params, reqOpts)
      else if (tab === 'expiring') res = await getUsersExpiring(params, reqOpts)
      else if (tab === 'failed') res = await getUsersFailedPayments(params, reqOpts)
      else res = await getUsers(params, reqOpts)
      return res
    },
    [tab, page, searchDebounced, expiringWithin],
  )

  const loadSummary = useCallback(async (signal) => {
    const gen = ++loadSummaryGenRef.current
    try {
      const res = await getUsersSummary(signal ? { signal } : {})
      if (gen !== loadSummaryGenRef.current) return
      if (res?.summary) setSummary(res.summary)
    } catch (e) {
      if (e?.name === 'AbortError') return
      /* badge counts are optional */
    }
  }, [])

  const loadTab = useCallback(
    async (opts = {}) => {
      const gen = ++loadTabGenRef.current
      fetchAbortRef.current?.abort()
      const ac = new AbortController()
      fetchAbortRef.current = ac
      const showSkeleton = !hasTableDataRef.current
      if (showSkeleton) setTableLoading(true)
      else setRefreshing(true)
      try {
        const res = await fetchTab(opts, ac.signal)
        if (gen !== loadTabGenRef.current) return
        const rows = Array.isArray(res?.items) ? res.items : []
        setItems(rows)
        setPagination(
          res?.pagination ?? { page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 },
        )
        if (rows.length > 0) hasTableDataRef.current = true
        loadedTabsRef.current.add(`${tab}:${expiringWithin}`)
      } catch (e) {
        if (e?.name === 'AbortError' || gen !== loadTabGenRef.current) return
        showToast('error', e?.message || 'Could not load users')
      } finally {
        if (gen === loadTabGenRef.current) {
          setTableLoading(false)
          setRefreshing(false)
        }
      }
    },
    [fetchTab, showToast, tab, expiringWithin],
  )

  useEffect(() => {
    getPlans()
      .then((p) => setPlans(Array.isArray(p) ? p : []))
      .catch(() => setPlans([]))
    void loadSummary()
  }, [loadSummary])

  useEffect(() => {
    void loadTab({ page })
  }, [loadTab, page])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['analytics']))
    const scheduleRefresh = () => {
      if (sseRefreshTimerRef.current) window.clearTimeout(sseRefreshTimerRef.current)
      sseRefreshTimerRef.current = window.setTimeout(() => {
        sseRefreshTimerRef.current = null
        void loadSummary()
        void loadTab({ page: pageRef.current })
      }, 400)
    }
    es.addEventListener('analytics.subscription_updated', scheduleRefresh)
    es.addEventListener('analytics.transaction_updated', scheduleRefresh)
    es.onerror = () => {
      scheduleRefresh()
    }
    return () => {
      if (sseRefreshTimerRef.current) window.clearTimeout(sseRefreshTimerRef.current)
      es.close()
    }
  }, [loadSummary, loadTab])

  useEffect(() => {
    const id = window.setInterval(() => setRemainingClock((t) => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  const subscriptionRows = tab !== 'failed'
  const visibleIds = useMemo(
    () => (subscriptionRows ? items.map((r) => String(r.device_id)) : []),
    [items, subscriptionRows],
  )
  const selectedCount = selected.size
  const allVisibleSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  function toggleOne(deviceId) {
    const id = String(deviceId)
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      if (allVisibleSelected) {
        const next = new Set(prev)
        visibleIds.forEach((id) => next.delete(id))
        return next
      }
      const next = new Set(prev)
      visibleIds.forEach((id) => next.add(id))
      return next
    })
  }

  async function handleSave(payload) {
    try {
      await putUser(payload.device_id, payload)
      setEditing(null)
      await Promise.all([loadTab({ page }), loadSummary()])
      showFlash('success', 'Subscription updated.')
    } catch (e) {
      showToast('error', e?.message || 'Update failed')
      throw e
    }
  }

  async function handleDelete(row) {
    if (!window.confirm(`Delete user + transactions for device ${row.device_id}?`)) return
    try {
      await deleteUser(row.device_id)
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(String(row.device_id))
        return next
      })
      await Promise.all([loadTab({ page }), loadSummary()])
      showFlash('success', 'User removed.')
    } catch (e) {
      if (e?.status === 400) {
        const force = window.confirm(
          'This user has an active subscription.\n\nDelete anyway with force=true?',
        )
        if (!force) return
        try {
          await deleteUser(row.device_id, { force: true })
          setSelected((prev) => {
            const next = new Set(prev)
            next.delete(String(row.device_id))
            return next
          })
          await Promise.all([loadTab({ page }), loadSummary()])
          showFlash('success', 'User removed with force delete.')
          return
        } catch (e2) {
          showToast('error', e2?.message || 'Force delete failed')
          return
        }
      }
      showToast('error', e?.message || 'Delete failed')
    }
  }

  async function runBulkDelete(deviceIds, { label }) {
    if (!deviceIds.length) return
    setBulkDeleting(true)
    try {
      const out = await deleteUsersBulk({ device_ids: deviceIds, force: true })
      const deleted = Number(out?.deleted) || 0
      const skipped = Number(out?.skipped) || 0
      setSelected(new Set())
      await Promise.all([loadTab({ page }), loadSummary()])
      if (deleted === 0 && deviceIds.length > 0) {
        showToast('error', 'No users were deleted. Refresh and retry.')
        return
      }
      showToast(
        'success',
        skipped > 0
          ? `${label}: removed ${deleted}, skipped ${skipped}.`
          : `${label}: removed ${deleted} user(s).`,
      )
      showFlash('success', `${label} complete.`)
    } catch (e) {
      showToast('error', e?.message || 'Bulk delete failed')
    } finally {
      setBulkDeleting(false)
      setConfirm(null)
    }
  }

  function planLabel(r) {
    if (r.plan_name) return r.plan_name
    if (r.plan_id != null) return planMap.get(Number(r.plan_id)) || `Plan #${r.plan_id}`
    return '-'
  }

  function providerLabel(r) {
    const p = String(r.provider ?? r.source ?? '').toLowerCase()
    if (!p) return '-'
    if (p === 'manual_grant') return 'Manual grant'
    if (p === 'offer_code') return 'Offer code'
    return p
  }

  const emptyMessage =
    tab === 'active_paid'
      ? 'No active paid subscriptions.'
      : tab === 'expiring'
        ? 'No subscriptions expiring in this window.'
        : tab === 'failed'
          ? 'No failed or abandoned payment attempts.'
          : 'No subscriptions yet.'

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Users / Subscriptions
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              Paginated views — device subscriptions (EAT display)
              {refreshing ? (
                <span className="ml-2 inline-flex items-center gap-1 text-amber-200/90">
                  <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
                  Updating…
                </span>
              ) : null}
              {!tableLoading && pagination.total > 0 ? (
                <span className="ml-2 text-slate-500">· {pagination.total} in this view</span>
              ) : null}
            </p>
          </div>
          {subscriptionRows ? (
            <div className="flex flex-wrap items-center gap-2">
              {selectedCount > 0 ? (
                <button
                  type="button"
                  disabled={bulkDeleting}
                  onClick={() =>
                    setConfirm({
                      kind: 'selected',
                      count: selectedCount,
                      ids: Array.from(selected),
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2.5 text-sm font-semibold text-red-200 hover:bg-red-500/20 disabled:opacity-50"
                >
                  {bulkDeleting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                  Delete selected ({selectedCount})
                </button>
              ) : null}
              {tab === 'all' ? (
                <button
                  type="button"
                  disabled={visibleIds.length === 0 || bulkDeleting}
                  onClick={() =>
                    setConfirm({
                      kind: 'all',
                      count: visibleIds.length,
                      ids: visibleIds,
                    })
                  }
                  className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/35 bg-red-950/40 px-4 py-2.5 text-sm font-semibold text-red-200 hover:bg-red-500/15 disabled:opacity-40"
                >
                  Delete page
                </button>
              ) : null}
            </div>
          ) : null}
        </header>

        <div className="flex flex-wrap gap-2">
          {TABS.map((t) => {
            const count = summary?.[t.countKey]
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`rounded-xl px-4 py-2.5 text-sm font-semibold transition-colors ${
                  tab === t.id
                    ? 'bg-[#f5b301]/20 text-amber-100 ring-1 ring-[#f5b301]/40'
                    : 'border border-slate-700/60 text-slate-400 hover:bg-slate-800/60 hover:text-slate-200'
                }`}
              >
                {t.label}
                {count != null ? (
                  <span className="ml-2 rounded-md bg-slate-800/80 px-1.5 py-0.5 text-xs font-bold text-slate-300">
                    {count}
                  </span>
                ) : null}
              </button>
            )
          })}
        </div>

        {tab === 'expiring' ? (
          <div className="flex flex-wrap gap-2">
            {EXPIRING_FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setExpiringWithin(f.within)}
                className={`rounded-lg px-3 py-1.5 text-xs font-semibold uppercase tracking-wide ${
                  expiringWithin === f.within
                    ? 'bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/40'
                    : 'border border-slate-700 text-slate-500 hover:text-slate-300'
                }`}
              >
                {f.label}
                {summary?.[f.countKey] != null ? ` (${summary[f.countKey]})` : ''}
              </button>
            ))}
          </div>
        ) : null}

        <div className="max-w-md">
          <label className={labelClass()} htmlFor="user-search">
            Search phone or device ID
          </label>
          <input
            id="user-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Device ID or phone…"
            className={inputClass()}
          />
        </div>

        <div
          className={`overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04] transition-opacity ${refreshing ? 'opacity-80' : ''}`}
        >
          <div className="overflow-x-auto">
            {tab === 'failed' ? (
              <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/80 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-semibold">Phone</th>
                    <th className="px-4 py-3 font-semibold">Device ID</th>
                    <th className="px-4 py-3 font-semibold">Plan</th>
                    <th className="px-4 py-3 font-semibold">Amount</th>
                    <th className="px-4 py-3 font-semibold">Provider</th>
                    <th className="px-4 py-3 font-semibold">Failure reason</th>
                    <th className="px-4 py-3 font-semibold">Created (EAT)</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Contact / retry</th>
                  </tr>
                </thead>
                {tableLoading ? (
                  <TableSkeleton cols={9} />
                ) : (
                  <tbody>
                    {items.map((r) => (
                      <tr
                        key={r.order_id || `${r.device_id}-${r.created_at}`}
                        className="border-b border-slate-800/80 hover:bg-slate-900/60"
                      >
                        <td className="px-4 py-3 font-mono text-slate-200">{r.phone_number || '-'}</td>
                        <td className="px-4 py-3 font-mono text-xs text-slate-200">{r.device_id || '-'}</td>
                        <td className="px-4 py-3 text-slate-300">{planLabel(r)}</td>
                        <td className="px-4 py-3 text-slate-300">{formatTsh(r.amount)}</td>
                        <td className="px-4 py-3 text-slate-400">{providerLabel(r)}</td>
                        <td className="max-w-[200px] px-4 py-3 text-slate-400">{r.failure_reason || '-'}</td>
                        <td className="px-4 py-3 text-slate-400">
                          {formatAdminDateTime(r.created_at, { fallback: '-' })}
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-lg px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${statusBadgeClass(r.last_status)}`}
                          >
                            {String(r.last_status || '').toUpperCase()}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-slate-500">{r.retry_hint || '-'}</td>
                      </tr>
                    ))}
                  </tbody>
                )}
              </table>
            ) : (
              <table className="w-full min-w-[1200px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/80 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
                    {tab === 'all' ? (
                      <th className="w-12 px-3 py-3">
                        <input
                          type="checkbox"
                          checked={allVisibleSelected}
                          onChange={toggleAllVisible}
                          disabled={visibleIds.length === 0 || bulkDeleting}
                          aria-label="Select all visible"
                          className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500/40"
                        />
                      </th>
                    ) : null}
                    <th className="px-4 py-3 font-semibold">Phone</th>
                    <th className="px-4 py-3 font-semibold">Device ID</th>
                    <th className="px-4 py-3 font-semibold">Plan</th>
                    <th className="px-4 py-3 font-semibold">Amount</th>
                    <th className="px-4 py-3 font-semibold">Started (EAT)</th>
                    <th className="px-4 py-3 font-semibold">Expiry (EAT)</th>
                    <th className="px-4 py-3 font-semibold">Remaining</th>
                    <th className="px-4 py-3 font-semibold">Provider</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    {tab === 'all' ? (
                      <th className="px-4 py-3 font-semibold text-right">Actions</th>
                    ) : null}
                  </tr>
                </thead>
                {tableLoading ? (
                  <TableSkeleton cols={tab === 'all' ? 11 : 9} />
                ) : (
                  <tbody>
                    {items.map((r) => {
                      const id = String(r.device_id)
                      const checked = selected.has(id)
                      return (
                        <tr
                          key={id}
                          className={`border-b border-slate-800/80 transition-colors hover:bg-slate-900/60 ${
                            checked ? 'bg-amber-500/[0.06]' : ''
                          }`}
                        >
                          {tab === 'all' ? (
                            <td className="px-3 py-3">
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => toggleOne(id)}
                                disabled={bulkDeleting}
                                aria-label={`Select ${id}`}
                                className="h-4 w-4 rounded border-slate-500 bg-slate-900 text-amber-500 focus:ring-amber-500/40"
                              />
                            </td>
                          ) : null}
                          <td className="px-4 py-3 font-mono text-slate-200">{r.phone_number || '-'}</td>
                          <td className="px-4 py-3 font-mono text-xs text-slate-200">{r.device_id}</td>
                          <td className="px-4 py-3 text-slate-300">{planLabel(r)}</td>
                          <td className="px-4 py-3 text-slate-300">
                            {r.amount != null ? formatTsh(r.amount) : '-'}
                          </td>
                          <td className="px-4 py-3 text-slate-400">
                            {formatAdminDateTime(r.started_at, { fallback: '-' })}
                          </td>
                          <td className="px-4 py-3 text-slate-400">
                            {formatAdminDateTime(r.expires_at, { fallback: '-' })}
                          </td>
                          <td className="px-4 py-3 text-slate-300">
                            {remainingClock >= 0 &&
                              formatAdminRemainingFromExpiry(r.expires_at, new Date())}
                          </td>
                          <td className="px-4 py-3 text-slate-400">{providerLabel(r)}</td>
                          <td className="px-4 py-3">
                            <span
                              className={`inline-flex rounded-lg px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${statusBadgeClass(r.status)}`}
                            >
                              {String(r.status || 'expired').toUpperCase()}
                            </span>
                          </td>
                          {tab === 'all' ? (
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                onClick={() => setEditing(r)}
                                disabled={bulkDeleting}
                                className="mr-1 inline-flex rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-amber-300 disabled:opacity-40"
                                aria-label="Edit"
                              >
                                <Pencil className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDelete(r)}
                                disabled={bulkDeleting}
                                className="inline-flex rounded-lg p-2 text-slate-400 hover:bg-red-500/15 hover:text-red-400 disabled:opacity-40"
                                aria-label="Delete"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          ) : null}
                        </tr>
                      )
                    })}
                  </tbody>
                )}
              </table>
            )}
          </div>
          {!tableLoading && items.length === 0 ? (
            <p className="py-12 text-center text-slate-500">{emptyMessage}</p>
          ) : null}
          <PaginationBar
            page={pagination.page}
            totalPages={pagination.totalPages}
            total={pagination.total}
            disabled={tableLoading || refreshing}
            onPageChange={setPage}
          />
        </div>

        <SubscriptionEditModal
          row={editing}
          plans={plans}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />

        <ConfirmModal
          open={confirm?.kind === 'selected'}
          title="Delete selected users?"
          message={`Remove ${confirm?.count ?? 0} selected subscription(s) and their transactions?`}
          confirmLabel="Delete selected"
          loading={bulkDeleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runBulkDelete(confirm?.ids ?? [], { label: 'Delete selected' })}
        />

        <ConfirmModal
          open={confirm?.kind === 'all'}
          title="Delete users on this page?"
          message="Remove all subscriptions shown on this page? This cannot be undone."
          confirmLabel="Delete page"
          loading={bulkDeleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runBulkDelete(confirm?.ids ?? [], { label: 'Delete page' })}
        />
      </main>
    </>
  )
}

export default function UsersPage() {
  return (
    <UsersPageErrorBoundary>
      <UsersPageContent />
    </UsersPageErrorBoundary>
  )
}
