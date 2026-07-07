import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardList, RefreshCw, Search, ShieldCheck } from 'lucide-react'
import Topbar from '../components/Topbar'
import AdminDeviceIdCell from '../components/AdminDeviceIdCell'
import SecurityPinModal from '../components/SecurityPinModal'
import { useToast } from '../context/ToastContext.jsx'
import {
  getPaymentOrders,
  postPaymentOrderRecover,
  postPaymentOrderReconcile,
  postPaymentOrderRejectRecovery,
  syncStreamUrl,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'
import { formatTsh } from '../lib/formatMoney'
import { shouldReplaceRows } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

const SSE_DEBOUNCE_MS = 1200
const PAGE_SIZE = 50

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'PENDING', label: 'Pending' },
  { id: 'SUCCESS', label: 'Success' },
  { id: 'FAILED', label: 'Failed' },
  { id: 'MANUALLY_APPROVED', label: 'Manual OK' },
]

function ledgerBadgeClass(status) {
  switch (status) {
    case 'SUCCESS':
      return 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30'
    case 'MANUALLY_APPROVED':
      return 'bg-violet-500/15 text-violet-200 ring-violet-500/30'
    case 'PENDING':
    case 'INITIATED':
      return 'bg-amber-500/15 text-amber-100 ring-amber-400/40'
    case 'FAILED':
    case 'RECOVERY_REJECTED':
      return 'bg-rose-500/15 text-rose-200 ring-rose-500/30'
    default:
      return 'bg-slate-600/40 text-slate-300 ring-slate-500/25'
  }
}

function recoveryBadgeClass(row) {
  const sev = row?.recoverySeverity
  if (sev === 'success') return 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30'
  if (sev === 'info') return 'bg-sky-500/15 text-sky-200 ring-sky-500/30'
  if (sev === 'neutral') return 'bg-slate-600/40 text-slate-300 ring-slate-500/25'
  if (sev === 'warning') return 'bg-amber-500/15 text-amber-100 ring-amber-400/40'
  if (sev === 'danger') return 'bg-rose-500/15 text-rose-200 ring-rose-500/30'
  const hint = row?.recoveryLabel || row?.recoveryHint || ''
  if (hint === 'Already Active' || hint === 'Manually Recovered' || hint === 'Activated / Historical') {
    return 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30'
  }
  if (hint === 'Hamisha Transfer' || hint === 'Superseded / Stacked' || hint === 'Manual Grant Override') {
    return 'bg-sky-500/15 text-sky-200 ring-sky-500/30'
  }
  if (hint === 'Pending at Provider' || hint === 'Admin Revoked' || hint === 'Needs Review') {
    return 'bg-amber-500/15 text-amber-100 ring-amber-400/40'
  }
  if (hint === 'Failed at Provider' || hint === 'Recovery Rejected' || hint === 'Unresolved Activation') {
    return 'bg-rose-500/15 text-rose-200 ring-rose-500/30'
  }
  return 'bg-slate-600/40 text-slate-300 ring-slate-500/25'
}

function recoveryTextClass(row) {
  const sev = row?.recoverySeverity
  if (sev === 'success') return 'text-emerald-300'
  if (sev === 'info') return 'text-sky-300'
  if (sev === 'neutral') return 'text-slate-400'
  if (sev === 'warning') return 'text-amber-200'
  if (sev === 'danger') return 'text-rose-300'
  return 'text-slate-400'
}

function showRecoverAction(row) {
  if (row?.recoveryClass === 'MANUALLY_RECOVERED' || row?.recoveryClass === 'ALREADY_ACTIVE') return false
  if (row?.recoveryDiagnosticClass === 'SYSTEM_MIGRATION') return false
  if (row?.recoveryHint === 'Already Active') return false
  if (row?.recoveryActionable === true) return true
  return row?.recoveryClass === 'TRUE_UNRESOLVED' || row?.recoveryClass === 'NEEDS_REVIEW'
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function cacheKey(tab, search, page) {
  return `payment-orders:${tab}:${String(search ?? '').trim() || '_'}:p${page}`
}

function hydrateTab(tab, search, page) {
  const snap = readAdminSnapshot(cacheKey(tab, search, page))
  return {
    rows: Array.isArray(snap?.rows) ? snap.rows : [],
    total: Number(snap?.total) || 0,
    totalPages: Number(snap?.totalPages) || 1,
    fromCache: Boolean(snap?.rows),
  }
}

function PaginationBar({ page, totalPages, total, onPageChange, disabled }) {
  if (totalPages <= 1 && total <= PAGE_SIZE) return null
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

export default function PaymentOrdersPage() {
  const { showToast } = useToast()
  const initial = useMemo(() => hydrateTab('all', '', 1), [])
  const [rows, setRows] = useState(initial.rows)
  const rowsRef = useRef(initial.rows)
  rowsRef.current = rows
  const [initialLoading, setInitialLoading] = useState(!initial.fromCache)
  const [refreshing, setRefreshing] = useState(false)
  const [loadError, setLoadError] = useState('')
  const hasRowsRef = useRef(initial.fromCache)
  const genRef = useRef(0)
  const [tab, setTab] = useState('all')
  const [searchInput, setSearchInput] = useState('')
  const [searchQuery, setSearchQuery] = useState('')
  const [searchRevision, setSearchRevision] = useState(0)
  const [page, setPage] = useState(1)
  const [total, setTotal] = useState(initial.total)
  const [totalPages, setTotalPages] = useState(initial.totalPages)
  const [pinExec, setPinExec] = useState(null)
  const [pinBusy, setPinBusy] = useState(false)
  const [pinError, setPinError] = useState('')
  const [confirmRow, setConfirmRow] = useState(null)
  const [ownerOverride, setOwnerOverride] = useState(false)

  useEffect(() => {
    const snap = hydrateTab(tab, searchQuery, page)
    setRows(snap.rows)
    rowsRef.current = snap.rows
    setTotal(snap.total)
    setTotalPages(snap.totalPages)
    hasRowsRef.current = snap.fromCache && snap.rows.length > 0
    setInitialLoading(!snap.fromCache)
    setLoadError('')
  }, [tab, searchQuery, page])

  const runSearchNow = useCallback(() => {
    const next = searchInput.trim()
    setSearchQuery(next)
    setPage(1)
    setSearchRevision((r) => r + 1)
  }, [searchInput])

  const handleTabChange = useCallback((nextTab) => {
    setTab(nextTab)
    setPage(1)
  }, [])

  const load = useCallback(async () => {
    const gen = ++genRef.current
    const isFirst = !hasRowsRef.current
    if (isFirst) setInitialLoading(true)
    else setRefreshing(true)
    setLoadError('')
    try {
      const data = await getPaymentOrders({
        status: tab,
        search: searchQuery.trim() || undefined,
        limit: PAGE_SIZE,
        page,
      })
      if (gen !== genRef.current) return
      const list = Array.isArray(data?.rows) ? data.rows : []
      const nextTotal = Number(data?.total) || list.length
      const nextTotalPages = Math.max(1, Number(data?.totalPages) || Math.ceil(nextTotal / PAGE_SIZE) || 1)
      if (!shouldReplaceRows(rowsRef.current, list, { allowEmpty: true })) return
      setRows(list)
      rowsRef.current = list
      setTotal(nextTotal)
      setTotalPages(nextTotalPages)
      hasRowsRef.current = true
      writeAdminSnapshot(cacheKey(tab, searchQuery, page), {
        rows: list,
        tab,
        search: searchQuery.trim(),
        page,
        total: nextTotal,
        totalPages: nextTotalPages,
      })
    } catch (e) {
      if (gen !== genRef.current) return
      const msg = e.message || 'Failed to load payment orders'
      setLoadError(msg)
      showToast(msg, 'error')
    } finally {
      if (gen === genRef.current) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }, [tab, searchQuery, searchRevision, page, showToast])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    const url = syncStreamUrl(['analytics'])
    const es = new EventSource(url)
    let debounceId = null
    es.onmessage = () => {
      window.clearTimeout(debounceId)
      debounceId = window.setTimeout(() => load(), SSE_DEBOUNCE_MS)
    }
    return () => {
      window.clearTimeout(debounceId)
      es.close()
    }
  }, [load])

  const runRecover = (row, withOwnerOverride = false) => {
    setConfirmRow(row)
    setOwnerOverride(withOwnerOverride)
    setPinExec(() => async (pin) => {
      setPinBusy(true)
      setPinError('')
      try {
        const body = {
          pin,
          confirm: true,
          reason: withOwnerOverride
            ? 'Owner-verified manual payment recovery'
            : 'Admin safe payment recovery',
          owner_override: withOwnerOverride,
        }
        try {
          await postPaymentOrderRecover(row.orderId, body)
        } catch (e) {
          const needsOverride =
            !withOwnerOverride &&
            (e?.status === 409 || e?.body?.requiresOwnerOverride === true)
          if (needsOverride) {
            setPinError('')
            setPinBusy(false)
            setPinExec(null)
            runRecover(row, true)
            showToast('Provider proof missing — confirm owner override to continue', 'info')
            return
          }
          throw e
        }
        showToast(`Order ${row.orderId} recovered`, 'success')
        setConfirmRow(null)
        setOwnerOverride(false)
        await load()
      } catch (e) {
        setPinError(e.message || 'Recovery failed')
        throw e
      } finally {
        setPinBusy(false)
      }
    })
  }

  const tableLoading = initialLoading || refreshing

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="rounded-2xl bg-amber-500/10 p-3 ring-1 ring-amber-500/20">
              <ClipboardList className="h-6 w-6 text-amber-300" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Payment Orders</h1>
              <p className="text-sm text-slate-400">Safe last-resort recovery — canonical activation when eligible</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              setSearchRevision((r) => r + 1)
            }}
            className="inline-flex items-center gap-2 rounded-xl border border-slate-600/70 bg-slate-900/80 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>

        <div className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <div className="mb-4 flex flex-wrap gap-2">
            {STATUS_TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => handleTabChange(t.id)}
                className={`rounded-xl px-4 py-2 text-sm font-medium ${
                  tab === t.id
                    ? 'bg-gradient-to-r from-amber-300 to-yellow-500 text-slate-950'
                    : 'bg-slate-800/70 text-slate-300 hover:text-white'
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <input
              className={`${inputClass()} min-w-[220px] flex-1`}
              placeholder="Search order ID, phone, device ID…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  runSearchNow()
                }
              }}
            />
            <button
              type="button"
              onClick={runSearchNow}
              disabled={tableLoading}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-300 to-yellow-500 px-5 py-2 text-sm font-semibold text-slate-950 hover:opacity-95 disabled:opacity-50"
            >
              <Search className={`h-4 w-4 ${tableLoading ? 'animate-pulse' : ''}`} />
              Search
            </button>
          </div>
          {searchQuery ? (
            <p className="mt-2 text-xs text-slate-500">
              Showing results for &ldquo;{searchQuery}&rdquo;
              {tableLoading ? ' — searching…' : total > 0 ? ` — ${total} match${total === 1 ? '' : 'es'}` : ''}
            </p>
          ) : null}
        </div>

        {loadError ? (
          <div className="rounded-xl border border-rose-500/40 bg-rose-950/30 px-4 py-3 text-sm text-rose-200">
            {loadError}
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <table className="min-w-[1280px] w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Order ID</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Recovery</th>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Created (EAT)</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {initialLoading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                    <span className="inline-flex items-center gap-2">
                      <RefreshCw className="h-4 w-4 animate-spin" /> Loading…
                    </span>
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                    {searchQuery
                      ? `No payment orders found for "${searchQuery}"`
                      : 'No payment orders found'}
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.orderId} className="hover:bg-slate-900/40">
                    <td className="px-4 py-3 font-mono text-xs text-amber-100/90">{row.orderId}</td>
                    <td className="px-4 py-3">{row.provider}</td>
                    <td className="px-4 py-3">{row.phone || '—'}</td>
                    <td className="px-4 py-3">{row.planName || '—'}</td>
                    <td className="px-4 py-3">{formatTsh(row.amount)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ${ledgerBadgeClass(row.ledgerStatus)}`}
                      >
                        {row.ledgerStatus}
                      </span>
                    </td>
                    <td className={`px-4 py-3 text-xs ${recoveryTextClass(row)}`} title={row.recoveryReason || ''}>
                      <span
                        className={`inline-flex rounded-lg px-2 py-0.5 text-xs font-medium ring-1 ${recoveryBadgeClass(row)}`}
                      >
                        {row.recoveryLabel || row.recoveryHint || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-3 max-w-[14rem]">
                      <AdminDeviceIdCell deviceId={row.deviceId} />
                    </td>
                    <td className="px-4 py-3 text-slate-300">{formatAdminDateTime(row.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {showRecoverAction(row) && row.recoveryHint !== 'Already Active' && (
                          <button
                            type="button"
                            onClick={() => runRecover(row, false)}
                            className="rounded-lg bg-emerald-600/90 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                          >
                            Recover
                          </button>
                        )}
                        {row.status === 'pending' && (
                          <button
                            type="button"
                            onClick={() =>
                              setPinExec(() => async (pin) => {
                                await postPaymentOrderReconcile(row.orderId, { pin })
                                showToast('Reconcile triggered', 'success')
                                await load()
                              })
                            }
                            className="rounded-lg bg-sky-600/80 px-3 py-1 text-xs font-semibold text-white hover:bg-sky-500"
                          >
                            Reconcile
                          </button>
                        )}
                        {row.recoveryState !== 'RECOVERY_REJECTED' && row.ledgerStatus !== 'SUCCESS' && (
                          <button
                            type="button"
                            onClick={() =>
                              setPinExec(() => async (pin) => {
                                await postPaymentOrderRejectRecovery(row.orderId, {
                                  pin,
                                  reason: 'Admin rejected recovery',
                                })
                                showToast('Recovery rejected', 'info')
                                await load()
                              })
                            }
                            className="rounded-lg bg-rose-600/70 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-500"
                          >
                            Reject
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
          <PaginationBar
            page={page}
            totalPages={totalPages}
            total={total}
            onPageChange={setPage}
            disabled={tableLoading}
          />
        </div>

        {confirmRow && (
          <div className="rounded-2xl border border-amber-500/30 bg-slate-900/90 p-4 text-sm text-slate-200">
            <div className="mb-2 flex items-center gap-2 font-semibold text-amber-200">
              <ShieldCheck className="h-4 w-4" /> Confirm safe recovery
            </div>
            <p>Order: {confirmRow.orderId}</p>
            <p>Device: {confirmRow.deviceId || confirmRow.deviceIdMasked}</p>
            <p>Phone: {confirmRow.phone}</p>
            <p>Provider: {confirmRow.provider}</p>
            <p>Amount: {formatTsh(confirmRow.amount)}</p>
            <p>Plan: {confirmRow.planName}</p>
            <p>Recovery: {confirmRow.recoveryLabel || confirmRow.recoveryHint}</p>
            {ownerOverride ? (
              <p className="mt-2 font-semibold text-rose-200">
                Owner override: granting without provider SUCCESS proof. Transaction status will NOT be falsified.
              </p>
            ) : (
              <p className="mt-2 text-slate-400">
                Server will poll provider when pending, then use canonical activation if payment is confirmed.
              </p>
            )}
          </div>
        )}
      </main>

      <SecurityPinModal
        open={pinExec != null}
        title="Ingiza Security PIN"
        errorText={pinError}
        busy={pinBusy}
        onClose={() => {
          setPinExec(null)
          setPinError('')
          setConfirmRow(null)
          setOwnerOverride(false)
        }}
        onSubmit={async (pin) => {
          if (pinExec) await pinExec(pin)
          setPinExec(null)
        }}
      />
    </>
  )
}
