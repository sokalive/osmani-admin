import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { deleteTransactionsBulk, getTransactions, syncStreamUrl } from '../lib/api'
import { endOfDay, isSameLocalDay, startOfDay } from '../lib/dates'
import { formatTsh } from '../lib/formatMoney'
import { shouldReplaceRows } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

const PAGE_SIZE = 10
const SSE_DEBOUNCE_MS = 1200

const tabs = [
  { id: 'all', label: 'All' },
  { id: 'completed', label: 'Completed' },
  { id: 'pending', label: 'Pending' },
  { id: 'failed', label: 'Failed' },
]

function statusBadgeClass(status) {
  switch (status) {
    case 'pending':
      return 'bg-amber-500/25 text-amber-100 ring-amber-400/50'
    case 'completed':
      return 'bg-emerald-500/25 text-emerald-100 ring-emerald-400/50'
    case 'failed':
      return 'bg-red-500/25 text-red-100 ring-red-400/50'
    default:
      return 'bg-slate-600/40 text-slate-300 ring-slate-500/50'
  }
}

function statusLabel(status) {
  if (!status) return ''
  return String(status).toUpperCase()
}

function formatEatDateTime(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '-'
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Dar_es_Salaam',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(d)
}

/** Today buckets: sum of amounts + transaction counts per status */
function computeTodayStats(transactions, todayRef = new Date()) {
  const empty = () => ({ sum: 0, count: 0 })
  const out = {
    completed: empty(),
    pending: empty(),
    failed: empty(),
  }
  for (const t of transactions) {
    if (!isSameLocalDay(t.created_at, todayRef)) continue
    const amt = Number(t.amount)
    if (!Number.isFinite(amt)) continue
    const st = String(t.status || '').toLowerCase()
    if (st === 'completed') {
      out.completed.sum += amt
      out.completed.count += 1
    } else if (st === 'pending') {
      out.pending.sum += amt
      out.pending.count += 1
    } else if (st === 'failed') {
      out.failed.sum += amt
      out.failed.count += 1
    }
  }
  return out
}

function TransactionsPage() {
  const { showToast } = useToast()
  const cached = readAdminSnapshot('transactions')
  const [transactions, setTransactions] = useState(
    Array.isArray(cached?.rows) ? cached.rows : [],
  )
  const hasDataRef = useRef(Array.isArray(cached?.rows))
  const rowsRef = useRef(Array.isArray(cached?.rows) ? cached.rows : [])
  rowsRef.current = transactions
  const genRef = useRef(0)
  const [tab, setTab] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)
  const [selectedOrderIds, setSelectedOrderIds] = useState(() => new Set())

  const loadTx = useCallback(async () => {
    const gen = ++genRef.current
    try {
      const rows = await getTransactions()
      if (gen !== genRef.current) return
      const list = Array.isArray(rows) ? rows : []
      if (!shouldReplaceRows(rowsRef.current, list)) return
      setTransactions(list)
      rowsRef.current = list
      hasDataRef.current = true
      writeAdminSnapshot('transactions', { rows: list })
      setSelectedOrderIds(new Set())
    } catch (e) {
      if (gen !== genRef.current) return
      showToast('error', e?.message || 'Could not load transactions')
      /* keep last-known-good rows on transient failure */
    }
  }, [showToast])

  useEffect(() => {
    loadTx()
  }, [loadTx])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['analytics']))
    let debounceId = null
    const onRefresh = () => {
      window.clearTimeout(debounceId)
      debounceId = window.setTimeout(() => void loadTx(), SSE_DEBOUNCE_MS)
    }
    es.addEventListener('analytics.transaction_updated', onRefresh)
    es.addEventListener('analytics.subscription_updated', onRefresh)
    return () => {
      window.clearTimeout(debounceId)
      es.close()
    }
  }, [loadTx])

  const todayStats = useMemo(() => computeTodayStats(transactions), [transactions])

  const filtered = useMemo(() => {
    const rows = transactions.filter((t) => {
      if (tab !== 'all' && String(t.status).toLowerCase() !== tab) return false
      if (fromDate) {
        const from = startOfDay(new Date(fromDate))
        if (new Date(t.created_at).getTime() < from.getTime()) return false
      }
      if (toDate) {
        const to = endOfDay(new Date(toDate))
        if (new Date(t.created_at).getTime() > to.getTime()) return false
      }
      return true
    })
    return [...rows].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
  }, [transactions, tab, fromDate, toDate])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const slice = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE
    return filtered.slice(start, start + PAGE_SIZE)
  }, [filtered, safePage, page])

  const allVisibleSelected =
    slice.length > 0 && slice.every((r) => selectedOrderIds.has(String(r.order_id)))

  function toggleSelectAllVisible() {
    setSelectedOrderIds((prev) => {
      const next = new Set(prev)
      if (allVisibleSelected) {
        slice.forEach((r) => next.delete(String(r.order_id)))
      } else {
        slice.forEach((r) => next.add(String(r.order_id)))
      }
      return next
    })
  }

  function toggleRowSelection(orderId) {
    const oid = String(orderId)
    setSelectedOrderIds((prev) => {
      const next = new Set(prev)
      if (next.has(oid)) next.delete(oid)
      else next.add(oid)
      return next
    })
  }

  async function handleDeleteSelected() {
    const ids = Array.from(selectedOrderIds)
    if (ids.length === 0) return
    if (!window.confirm(`Delete ${ids.length} selected transactions?`)) return
    try {
      await deleteTransactionsBulk(ids)
      showToast('success', 'Selected transactions deleted.')
      await loadTx()
    } catch (e) {
      showToast('error', e?.message || 'Failed to delete selected transactions')
    }
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Transactions
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Payments and order activity from the live API
          </p>
        </header>

        <section className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <article className="relative overflow-hidden rounded-2xl border border-emerald-500/35 bg-gradient-to-br from-emerald-950/80 via-emerald-950/50 to-slate-950/80 p-6 shadow-[0_16px_40px_rgba(16,185,129,0.12)] ring-1 ring-emerald-400/25">
            <div className="pointer-events-none absolute -right-6 -top-6 h-28 w-28 rounded-full bg-emerald-400/15 blur-2xl" />
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-emerald-300/95">
              Completed Today
            </p>
            <p className="mt-4 text-3xl font-extrabold tracking-tight text-white">
              {formatTsh(todayStats.completed.sum)}
            </p>
            <p className="mt-2 text-sm font-medium text-emerald-200/85">
              {todayStats.completed.count}{' '}
              {todayStats.completed.count === 1 ? 'transaction' : 'transactions'}
            </p>
          </article>

          <article className="relative overflow-hidden rounded-2xl border border-amber-500/40 bg-gradient-to-br from-amber-950/70 via-orange-950/40 to-slate-950/80 p-6 shadow-[0_16px_40px_rgba(245,158,11,0.14)] ring-1 ring-amber-400/30">
            <div className="pointer-events-none absolute -right-6 -top-6 h-28 w-28 rounded-full bg-amber-400/15 blur-2xl" />
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-amber-200/95">
              Pending Today
            </p>
            <p className="mt-4 text-3xl font-extrabold tracking-tight text-white">
              {formatTsh(todayStats.pending.sum)}
            </p>
            <p className="mt-2 text-sm font-medium text-amber-100/85">
              {todayStats.pending.count}{' '}
              {todayStats.pending.count === 1 ? 'transaction' : 'transactions'}
            </p>
          </article>

          <article className="relative overflow-hidden rounded-2xl border border-red-500/35 bg-gradient-to-br from-red-950/80 via-rose-950/45 to-slate-950/80 p-6 shadow-[0_16px_40px_rgba(239,68,68,0.12)] ring-1 ring-red-400/25">
            <div className="pointer-events-none absolute -right-6 -top-6 h-28 w-28 rounded-full bg-red-400/15 blur-2xl" />
            <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-red-300/95">
              Failed Today
            </p>
            <p className="mt-4 text-3xl font-extrabold tracking-tight text-white">
              {formatTsh(todayStats.failed.sum)}
            </p>
            <p className="mt-2 text-sm font-medium text-red-100/85">
              {todayStats.failed.count}{' '}
              {todayStats.failed.count === 1 ? 'transaction' : 'transactions'}
            </p>
          </article>
        </section>

        <div className="flex flex-col gap-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-4 ring-1 ring-white/[0.04] lg:flex-row lg:items-end lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {tabs.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  setTab(t.id)
                  setPage(1)
                }}
                className={`rounded-xl px-4 py-2.5 text-xs font-bold uppercase tracking-wide transition-all duration-200 ${
                  tab === t.id
                    ? 'bg-gradient-to-r from-amber-400 to-yellow-500 text-slate-950 shadow-[0_8px_24px_rgba(251,191,36,0.25)]'
                    : 'bg-slate-800/70 text-slate-300 hover:bg-slate-800'
                }`}
              >
                {t.label.toUpperCase()}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              From
              <input
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setFromDate(e.target.value)
                  setPage(1)
                }}
                className="rounded-xl border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white focus:border-amber-500/50 focus:outline-none focus:ring-2 focus:ring-amber-500/25"
              />
            </label>
            <label className="flex flex-col gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              To
              <input
                type="date"
                value={toDate}
                onChange={(e) => {
                  setToDate(e.target.value)
                  setPage(1)
                }}
                className="rounded-xl border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-white focus:border-amber-500/50 focus:outline-none focus:ring-2 focus:ring-amber-500/25"
              />
            </label>
            {(fromDate || toDate) ? (
              <button
                type="button"
                onClick={() => {
                  setFromDate('')
                  setToDate('')
                  setPage(1)
                }}
                className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800"
              >
                Clear dates
              </button>
            ) : null}
            <button
              type="button"
              onClick={toggleSelectAllVisible}
              className="rounded-xl border border-slate-600 px-4 py-2 text-sm font-medium text-slate-300 transition-colors hover:bg-slate-800"
            >
              Select All
            </button>
            <button
              type="button"
              disabled={selectedOrderIds.size === 0}
              onClick={handleDeleteSelected}
              className="rounded-xl border border-red-500/40 px-4 py-2 text-sm font-medium text-red-200 transition-colors hover:bg-red-500/15 disabled:opacity-50"
            >
              Delete Selected
            </button>
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700/80 bg-slate-900/60 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3.5 font-semibold">Select</th>
                  <th className="px-4 py-3.5 font-semibold">Phone</th>
                  <th className="px-4 py-3.5 font-semibold">Device ID</th>
                  <th className="px-4 py-3.5 font-semibold">Amount</th>
                  <th className="px-4 py-3.5 font-semibold">Order ID</th>
                  <th className="px-4 py-3.5 font-semibold">Status</th>
                  <th className="px-4 py-3.5 font-semibold">Date (EAT)</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((row) => (
                  <tr
                    key={row.order_id}
                    className="border-b border-slate-800/80 transition-colors hover:bg-slate-900/55"
                  >
                    <td className="px-4 py-3.5">
                      <input
                        type="checkbox"
                        checked={selectedOrderIds.has(String(row.order_id))}
                        onChange={() => toggleRowSelection(row.order_id)}
                      />
                    </td>
                    <td className="px-4 py-3.5 font-mono text-[13px] text-slate-200">
                      {row.phone || '-'}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-slate-300">
                      {row.device_id || '-'}
                    </td>
                    <td className="px-4 py-3.5 font-semibold tabular-nums text-amber-100">
                      {formatTsh(row.amount)}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-slate-400">{row.order_id}</td>
                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex rounded-lg px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ${statusBadgeClass(String(row.status).toLowerCase())}`}
                      >
                        {statusLabel(row.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300 tabular-nums">
                      {formatEatDateTime(row.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 ? (
            <p className="py-14 text-center text-sm text-slate-500">
              No transactions match your filters.
            </p>
          ) : null}

          {filtered.length > PAGE_SIZE ? (
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-800/80 px-4 py-3 text-sm text-slate-400">
              <span>
                Page {safePage} of {totalPages} · {filtered.length} rows
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={safePage <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  className="rounded-lg border border-slate-600 px-3 py-1.5 font-medium text-slate-200 transition-colors enabled:hover:bg-slate-800 disabled:opacity-40"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={safePage >= totalPages}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  className="rounded-lg border border-slate-600 px-3 py-1.5 font-medium text-slate-200 transition-colors enabled:hover:bg-slate-800 disabled:opacity-40"
                >
                  Next
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </main>
    </>
  )
}

export default TransactionsPage
