import { useCallback, useEffect, useMemo, useRef, useState, Component } from 'react'
import { Eye, Loader2, Pencil, Search, Trash2 } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import SubscriptionEditModal from '../components/SubscriptionEditModal'
import Topbar from '../components/Topbar'
import AdminDeviceIdCell from '../components/AdminDeviceIdCell'
import UserProfileDrawer from '../components/UserProfileDrawer'
import { useToast } from '../context/ToastContext.jsx'
import {
  postUserRevoke,
  postUsersBulkRevoke,
  getPlans,
  getUsers,
  getUsersActive,
  getUsersExpiring,
  getUsersFailedPayments,
  getUsersSummary,
  getUsersLookup,
  putUser,
  syncStreamUrl,
} from '../lib/api'
import { formatAdminDateTime, formatAdminRemainingFromExpiry } from '../lib/formatAdminDateTime'
import { formatTsh } from '../lib/formatMoney'
import {
  fingerprintPagination,
  fingerprintSummary,
  fingerprintUserRowsContent,
  mergeUserRows,
} from '../lib/usersPageRefresh'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'
import { shouldReplaceRows } from '../lib/adminDataGuards'

const PAGE_SIZE = 25

const PROVIDER_FILTERS = [
  { id: 'all', label: 'All providers' },
  { id: 'sonicpesa', label: 'SonicPesa' },
  { id: 'zenopay', label: 'ZenoPay' },
  { id: 'auraxpay', label: 'AuraxPay' },
  { id: 'manual_grant', label: 'Manual grant' },
  { id: 'transfer', label: 'Transfer' },
  { id: 'recovery', label: 'Recovery' },
]

const STATUS_FILTERS = [
  { id: 'all', label: 'All statuses' },
  { id: 'active', label: 'Active' },
  { id: 'expired', label: 'Expired' },
]

function RemainingCell({ expiresAt }) {
  const [, setTick] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setTick((t) => t + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])
  return <>{formatAdminRemainingFromExpiry(expiresAt, new Date())}</>
}

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
  if (status === 'revoked') return 'bg-orange-500/20 text-orange-200 ring-orange-400/40'
  if (status === 'failed') return 'bg-red-500/20 text-red-200 ring-red-400/40'
  if (status === 'historical') return 'bg-sky-500/20 text-sky-200 ring-sky-400/40'
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

function usersCacheKey(tab, expiringWithin) {
  return `users:${tab}:${expiringWithin}`
}

function hydrateUsersTab(tab, expiringWithin) {
  const snap = readAdminSnapshot(usersCacheKey(tab, expiringWithin))
  if (!snap || typeof snap !== 'object') return null
  return {
    items: Array.isArray(snap.items) ? snap.items : [],
    pagination: snap.pagination ?? { page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 },
    summary: snap.summary ?? null,
  }
}

function UsersPageContent() {
  const { showToast } = useToast()
  const [tab, setTab] = useState('active_paid')
  const [expiringWithin, setExpiringWithin] = useState('7d')
  const initialHydrate = useMemo(() => hydrateUsersTab('active_paid', '7d'), [])
  const [page, setPage] = useState(1)
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchRevision, setSearchRevision] = useState(0)
  const [searchLoading, setSearchLoading] = useState(false)
  const [lookupResult, setLookupResult] = useState(null)
  const [planFilter, setPlanFilter] = useState('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [statusFilter, setStatusFilter] = useState('all')
  const [items, setItems] = useState(() => initialHydrate?.items ?? [])
  const [pagination, setPagination] = useState(
    () => initialHydrate?.pagination ?? { page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 },
  )
  const [summary, setSummary] = useState(() => initialHydrate?.summary ?? null)
  const [plans, setPlans] = useState([])
  const [editing, setEditing] = useState(null)
  const [flash, setFlash] = useState(null)
  const [tableLoading, setTableLoading] = useState(() => !(initialHydrate?.items?.length > 0))
  const [profileRow, setProfileRow] = useState(null)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirm, setConfirm] = useState(null)
  const loadedTabsRef = useRef(new Set())
  const loadTabGenRef = useRef(0)
  const loadSummaryGenRef = useRef(0)
  const silentTabGenRef = useRef(0)
  const sseRefreshTimerRef = useRef(null)
  const fetchAbortRef = useRef(null)
  const silentFetchAbortRef = useRef(null)
  const hasEverLoadedTableRef = useRef(initialHydrate?.items?.length > 0)
  const itemsFingerprintRef = useRef('')
  const paginationFingerprintRef = useRef('')
  const summaryFingerprintRef = useRef('')
  const pageRef = useRef(page)
  const tabRef = useRef(tab)
  pageRef.current = page
  tabRef.current = tab

  useEffect(() => {
    const t = window.setTimeout(() => setSearchQuery((prev) => {
      const next = searchInput.trim()
      return prev === next ? prev : next
    }), 400)
    return () => window.clearTimeout(t)
  }, [searchInput])

  const runSearchNow = useCallback(() => {
    const next = searchInput.trim()
    setSearchQuery(next)
    setPage(1)
    setSelected(new Set())
    setSearchRevision((r) => r + 1)
    setSearchLoading(true)
  }, [searchInput])

  useEffect(() => {
    setPage(1)
    setSelected(new Set())
  }, [tab, expiringWithin, searchQuery, planFilter, providerFilter, statusFilter])

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
        search: searchQuery || undefined,
        sort:
          tab === 'expiring'
            ? 'expiry_soonest'
            : tab === 'failed'
              ? 'newest'
              : 'started_newest',
        plan_id: planFilter !== 'all' ? planFilter : undefined,
        provider: providerFilter !== 'all' ? providerFilter : undefined,
        status: tab === 'all' && statusFilter !== 'all' ? statusFilter : undefined,
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
    [tab, page, searchQuery, expiringWithin, planFilter, providerFilter, statusFilter],
  )

  const loadSummary = useCallback(async (signal, { silent = false } = {}) => {
    const gen = ++loadSummaryGenRef.current
    try {
      const res = await getUsersSummary(signal ? { signal } : {})
      if (gen !== loadSummaryGenRef.current) return
      if (res?.summary) {
        const fp = fingerprintSummary(res.summary)
        if (!silent || fp !== summaryFingerprintRef.current) {
          summaryFingerprintRef.current = fp
          setSummary(res.summary)
        }
      }
    } catch (e) {
      if (e?.name === 'AbortError') return
      /* badge counts are optional */
    }
  }, [])

  const applyTabResult = useCallback(
    (res, { silent = false, currentTab = tab } = {}) => {
      const rows = Array.isArray(res?.items) ? res.items : []
      const nextPagination = res?.pagination ?? { page: 1, limit: PAGE_SIZE, total: 0, totalPages: 1 }
      const pagFp = fingerprintPagination(nextPagination)
      const pagChanged = pagFp !== paginationFingerprintRef.current

      setItems((prev) => {
        const nextRows = silent ? mergeUserRows(prev, rows, currentTab, { silent: true }) : rows
        if (!silent && !shouldReplaceRows(prev, nextRows)) return prev
        const nextFp = fingerprintUserRowsContent(nextRows, currentTab)
        if (nextFp === itemsFingerprintRef.current && !pagChanged) return prev
        itemsFingerprintRef.current = nextFp
        return nextRows
      })

      if (pagChanged) {
        paginationFingerprintRef.current = pagFp
        setPagination(nextPagination)
      }

      if (rows.length > 0) hasEverLoadedTableRef.current = true
      loadedTabsRef.current.add(`${currentTab}:${expiringWithin}`)
      writeAdminSnapshot(usersCacheKey(currentTab, expiringWithin), {
        items: rows,
        pagination: nextPagination,
      })
    },
    [tab, expiringWithin],
  )

  useEffect(() => {
    const h = hydrateUsersTab(tab, expiringWithin)
    if (h?.items?.length) {
      itemsFingerprintRef.current = fingerprintUserRowsContent(h.items, tab)
      paginationFingerprintRef.current = fingerprintPagination(h.pagination)
      setItems(h.items)
      setPagination(h.pagination)
      hasEverLoadedTableRef.current = true
      setTableLoading(false)
    }
  }, [tab, expiringWithin])

  const loadTabSilent = useCallback(async () => {
    const gen = ++silentTabGenRef.current
    silentFetchAbortRef.current?.abort()
    const ac = new AbortController()
    silentFetchAbortRef.current = ac
    const currentTab = tabRef.current
    try {
      const res = await fetchTab({ page: pageRef.current }, ac.signal)
      if (gen !== silentTabGenRef.current) return
      applyTabResult(res, { silent: true, currentTab })
    } catch (e) {
      if (e?.name === 'AbortError') return
      /* keep existing rows on silent background errors */
    }
  }, [fetchTab, applyTabResult])

  const loadTab = useCallback(
    async (opts = {}) => {
      const gen = ++loadTabGenRef.current
      fetchAbortRef.current?.abort()
      const ac = new AbortController()
      fetchAbortRef.current = ac
      const showSkeleton = !hasEverLoadedTableRef.current
      if (showSkeleton) setTableLoading(true)
      try {
        const res = await fetchTab(opts, ac.signal)
        if (gen !== loadTabGenRef.current) return
        applyTabResult(res, { silent: false })
      } catch (e) {
        if (e?.name === 'AbortError' || gen !== loadTabGenRef.current) return
        showToast('error', e?.message || 'Could not load users')
      } finally {
        if (gen === loadTabGenRef.current) {
          setTableLoading(false)
          setSearchLoading(false)
        }
      }
    },
    [fetchTab, showToast, applyTabResult],
  )

  const fetchLookup = useCallback(async (q, revision, signal) => {
    const term = String(q ?? '').trim()
    if (!term) {
      setLookupResult(null)
      return
    }
    const isDevice = /^[a-f0-9]{64}$/i.test(term)
    const digits = term.replace(/\D/g, '')
    if (!isDevice && digits.length < 9) {
      setLookupResult(null)
      return
    }
    try {
      const res = await getUsersLookup(term, signal ? { signal } : {})
      setLookupResult(res?.found ? res : null)
    } catch (e) {
      if (e?.name === 'AbortError') return
      setLookupResult(null)
    }
  }, [])

  useEffect(() => {
    getPlans()
      .then((p) => setPlans(Array.isArray(p) ? p : []))
      .catch(() => setPlans([]))
    void loadSummary()
  }, [loadSummary])

  useEffect(() => {
    void loadTab({ page })
  }, [loadTab, page, searchRevision])

  useEffect(() => {
    const ac = new AbortController()
    void fetchLookup(searchQuery, searchRevision, ac.signal)
    return () => ac.abort()
  }, [searchQuery, searchRevision, fetchLookup])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['analytics']))
    const scheduleRefresh = (kind) => {
      const current = tabRef.current
      if (kind === 'subscription' && current === 'failed') return
      if (kind === 'transaction' && current !== 'failed' && current !== 'all') return
      if (sseRefreshTimerRef.current) window.clearTimeout(sseRefreshTimerRef.current)
      sseRefreshTimerRef.current = window.setTimeout(() => {
        sseRefreshTimerRef.current = null
        void loadSummary(undefined, { silent: true })
        void loadTabSilent()
      }, 1500)
    }
    es.addEventListener('analytics.subscription_updated', () => scheduleRefresh('subscription'))
    es.addEventListener('analytics.transaction_updated', () => scheduleRefresh('transaction'))
    return () => {
      if (sseRefreshTimerRef.current) window.clearTimeout(sseRefreshTimerRef.current)
      silentFetchAbortRef.current?.abort()
      es.close()
    }
  }, [loadSummary, loadTabSilent])

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

  async function handleRevoke(row) {
    if (
      !window.confirm(
        `Revoke subscription for device ${row.device_id}?\n\nPayment history will be preserved for audit.`,
      )
    ) {
      return
    }
    try {
      await postUserRevoke(row.device_id, { reason: 'admin_users_page' })
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(String(row.device_id))
        return next
      })
      await Promise.all([loadTab({ page }), loadSummary()])
      showFlash('success', 'Subscription revoked — App access should drop immediately.')
    } catch (e) {
      showToast('error', e?.message || 'Revoke failed')
    }
  }

  async function runBulkRevoke(deviceIds, { label }) {
    if (!deviceIds.length) return
    setBulkDeleting(true)
    try {
      const out = await postUsersBulkRevoke({ device_ids: deviceIds, reason: 'admin_users_bulk' })
      const revoked = Number(out?.revoked) || 0
      const skipped = Number(out?.skipped) || 0
      setSelected(new Set())
      await Promise.all([loadTab({ page }), loadSummary()])
      if (revoked === 0 && deviceIds.length > 0) {
        showToast('error', 'No subscriptions were revoked. Refresh and retry.')
        return
      }
      showToast(
        'success',
        skipped > 0
          ? `${label}: revoked ${revoked}, skipped ${skipped}. Payment history preserved.`
          : `${label}: revoked ${revoked} subscription(s). Payment history preserved.`,
      )
      showFlash('success', `${label} complete.`)
    } catch (e) {
      showToast('error', e?.message || 'Bulk revoke failed')
    } finally {
      setBulkDeleting(false)
      setConfirm(null)
    }
  }

  async function handleDelete(row) {
    return handleRevoke(row)
  }

  async function runBulkDelete(deviceIds, opts) {
    return runBulkRevoke(deviceIds, opts)
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
                  Revoke selected ({selectedCount})
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
                  Revoke page
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

        <div className="flex flex-col gap-4 lg:flex-row lg:flex-wrap lg:items-end">
          <div className="min-w-[240px] flex-1 max-w-md">
            <label className={labelClass()} htmlFor="user-search">
              Search
            </label>
            <div className="flex gap-2">
              <input
                id="user-search"
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    runSearchNow()
                  }
                }}
                placeholder="Phone, device ID, order ID, transaction ID, reference…"
                className={inputClass()}
              />
              <button
                type="button"
                onClick={runSearchNow}
                disabled={searchLoading}
                className="inline-flex shrink-0 items-center gap-2 rounded-xl border border-[#f5b301]/40 bg-[#f5b301]/15 px-4 py-3 text-sm font-semibold text-amber-100 hover:bg-[#f5b301]/25 disabled:opacity-50"
              >
                {searchLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Search
              </button>
            </div>
            <p className="mt-1 text-[11px] text-slate-500">
              Press Enter or Search for immediate lookup. Auto-search also runs after typing pauses.
              {searchLoading ? <span className="ml-2 text-amber-300">Searching…</span> : null}
            </p>
          </div>
          {lookupResult?.devices?.length ? (
            <div className="w-full rounded-2xl border border-cyan-500/25 bg-cyan-950/20 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-cyan-200/90">
                Phone search
                {lookupResult.normalized_phone ? (
                  <span className="ml-2 font-mono normal-case text-slate-200">
                    +{lookupResult.normalized_phone}
                  </span>
                ) : null}
                <span className="ml-2 font-normal normal-case text-slate-400">
                  · {lookupResult.devices.length} device{lookupResult.devices.length === 1 ? '' : 's'}
                </span>
                {lookupResult.ms != null ? (
                  <span className="ml-2 font-normal normal-case text-slate-500">({lookupResult.ms}ms)</span>
                ) : null}
              </p>
              <div className="mt-3 overflow-x-auto rounded-xl border border-slate-700/60">
                <table className="min-w-full text-sm">
                  <thead className="bg-slate-900/60 text-left text-[11px] uppercase tracking-wide text-slate-400">
                    <tr>
                      <th className="px-3 py-2">Device ID</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Provider</th>
                      <th className="px-3 py-2">Plan</th>
                      <th className="px-3 py-2">Expires</th>
                      <th className="px-3 py-2">Payments</th>
                      <th className="px-3 py-2">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/80">
                    {lookupResult.devices.map((bundle) => {
                      const sub = bundle.subscription
                      const row = sub || { device_id: bundle.device_id, status: 'unknown', provider: 'unknown' }
                      return (
                        <tr key={bundle.device_id} className="bg-slate-900/30 hover:bg-slate-900/50">
                          <td className="max-w-[14rem] px-3 py-2">
                            <AdminDeviceIdCell deviceId={bundle.device_id} />
                          </td>
                          <td className="px-3 py-2">
                            {sub?.status ? (
                              <span
                                className={`inline-flex rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1 ${statusBadgeClass(sub.status)}`}
                              >
                                {String(sub.status).toUpperCase()}
                              </span>
                            ) : (
                              <span className="text-xs text-slate-500">—</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-300">{sub?.provider || sub?.source || '—'}</td>
                          <td className="px-3 py-2 text-xs text-slate-300">{sub?.plan_name || '—'}</td>
                          <td className="px-3 py-2 text-xs text-slate-400">
                            {sub?.expires_at ? formatAdminDateTime(sub.expires_at) : '—'}
                          </td>
                          <td className="px-3 py-2 text-xs text-slate-400">{bundle.payment_count ?? bundle.transactions?.length ?? 0}</td>
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap gap-1.5">
                              <button
                                type="button"
                                onClick={() => setProfileRow(row)}
                                className="rounded-lg border border-slate-600 px-2 py-1 text-[11px] text-slate-200 hover:bg-slate-800"
                              >
                                <Eye className="mr-1 inline h-3 w-3" />
                                View
                              </button>
                              {sub ? (
                                <>
                                  <button
                                    type="button"
                                    onClick={() => setEditing(sub)}
                                    className="rounded-lg border border-amber-500/40 px-2 py-1 text-[11px] text-amber-100 hover:bg-amber-500/10"
                                  >
                                    <Pencil className="mr-1 inline h-3 w-3" />
                                    Edit
                                  </button>
                                  <button
                                    type="button"
                                    disabled={sub.status === 'revoked'}
                                    onClick={() => handleRevoke(sub)}
                                    className="rounded-lg border border-red-500/40 px-2 py-1 text-[11px] text-red-200 hover:bg-red-500/10 disabled:opacity-40"
                                  >
                                    <Trash2 className="mr-1 inline h-3 w-3" />
                                    Revoke
                                  </button>
                                </>
                              ) : null}
                            </div>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          ) : null}
          {subscriptionRows ? (
            <>
              <div className="min-w-[140px]">
                <label className={labelClass()} htmlFor="user-plan-filter">
                  Plan
                </label>
                <select
                  id="user-plan-filter"
                  value={planFilter}
                  onChange={(e) => setPlanFilter(e.target.value)}
                  className={inputClass()}
                >
                  <option value="all">All plans</option>
                  {plans.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-[160px]">
                <label className={labelClass()} htmlFor="user-provider-filter">
                  Source
                </label>
                <select
                  id="user-provider-filter"
                  value={providerFilter}
                  onChange={(e) => setProviderFilter(e.target.value)}
                  className={inputClass()}
                >
                  {PROVIDER_FILTERS.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ))}
                </select>
              </div>
              {tab === 'all' ? (
                <div className="min-w-[140px]">
                  <label className={labelClass()} htmlFor="user-status-filter">
                    Status
                  </label>
                  <select
                    id="user-status-filter"
                    value={statusFilter}
                    onChange={(e) => setStatusFilter(e.target.value)}
                    className={inputClass()}
                  >
                    {STATUS_FILTERS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </>
          ) : (
            <div className="min-w-[160px]">
              <label className={labelClass()} htmlFor="failed-provider-filter">
                Provider
              </label>
              <select
                id="failed-provider-filter"
                value={providerFilter}
                onChange={(e) => setProviderFilter(e.target.value)}
                className={inputClass()}
              >
                {PROVIDER_FILTERS.filter((f) => f.id !== 'manual_grant' && f.id !== 'transfer' && f.id !== 'recovery').map(
                  (f) => (
                    <option key={f.id} value={f.id}>
                      {f.label}
                    </option>
                  ),
                )}
              </select>
            </div>
          )}
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
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
                    <th className="px-4 py-3 font-semibold text-right">Profile</th>
                  </tr>
                </thead>
                {tableLoading && items.length === 0 ? (
                  <TableSkeleton cols={10} />
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
                        <td className="px-4 py-3 text-right">
                          <button
                            type="button"
                            onClick={() => setProfileRow(r)}
                            className="inline-flex rounded-lg p-2 text-slate-400 hover:bg-cyan-500/10 hover:text-cyan-300"
                            aria-label="View profile"
                          >
                            <Eye className="h-4 w-4" />
                          </button>
                        </td>
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
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                {tableLoading && items.length === 0 ? (
                  <TableSkeleton cols={tab === 'all' ? 11 : 10} />
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
                          <td className="max-w-[14rem] px-4 py-3">
                            <AdminDeviceIdCell deviceId={r.device_id} />
                          </td>
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
                            <RemainingCell expiresAt={r.expires_at} />
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
                                onClick={() => setProfileRow(r)}
                                className="mr-1 inline-flex rounded-lg p-2 text-slate-400 hover:bg-cyan-500/10 hover:text-cyan-300"
                                aria-label="View profile"
                              >
                                <Eye className="h-4 w-4" />
                              </button>
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
                                onClick={() => handleRevoke(r)}
                                disabled={bulkDeleting || r.status === 'revoked'}
                                className="inline-flex rounded-lg p-2 text-slate-400 hover:bg-red-500/15 hover:text-red-400 disabled:opacity-40"
                                aria-label="Revoke subscription"
                                title="Revoke subscription (preserves payment history)"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          ) : (
                            <td className="px-4 py-3 text-right">
                              <button
                                type="button"
                                onClick={() => setProfileRow(r)}
                                className="mr-1 inline-flex rounded-lg p-2 text-slate-400 hover:bg-cyan-500/10 hover:text-cyan-300"
                                aria-label="View profile"
                              >
                                <Eye className="h-4 w-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleRevoke(r)}
                                disabled={bulkDeleting || r.status === 'revoked'}
                                className="inline-flex rounded-lg p-2 text-slate-400 hover:bg-red-500/15 hover:text-red-400 disabled:opacity-40"
                                aria-label="Revoke subscription"
                                title="Revoke subscription (preserves payment history)"
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </td>
                          )}
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
            disabled={tableLoading}
            onPageChange={setPage}
          />
        </div>

        <UserProfileDrawer
          row={profileRow}
          tab={tab}
          onClose={() => setProfileRow(null)}
          onEditSubscription={(r) => {
            setProfileRow(null)
            setEditing(r)
          }}
        />

        <SubscriptionEditModal
          row={editing}
          plans={plans}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />

        <ConfirmModal
          open={confirm?.kind === 'selected'}
          title="Revoke selected subscriptions?"
          message={`Revoke ${confirm?.count ?? 0} selected subscription(s)? Payment transaction history will be preserved.`}
          confirmLabel="Revoke selected"
          loading={bulkDeleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runBulkRevoke(confirm?.ids ?? [], { label: 'Revoke selected' })}
        />

        <ConfirmModal
          open={confirm?.kind === 'all'}
          title="Revoke subscriptions on this page?"
          message="Revoke all subscriptions shown on this page? App access ends immediately. Payment history remains for audit."
          confirmLabel="Revoke page"
          loading={bulkDeleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runBulkRevoke(confirm?.ids ?? [], { label: 'Revoke page' })}
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
