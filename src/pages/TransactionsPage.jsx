import { useCallback, useEffect, useMemo, useState } from 'react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getTransactions } from '../lib/api'
import { endOfDay, isSameLocalDay, startOfDay } from '../lib/dates'
import { formatTsh } from '../lib/formatMoney'
import { formatReadableDateTime } from '../lib/formatTxDisplay'

const PAGE_SIZE = 10

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
  return status.charAt(0).toUpperCase() + status.slice(1)
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
    if (!isSameLocalDay(t.date, todayRef)) continue
    const amt = Number(t.amount)
    if (!Number.isFinite(amt)) continue
    if (t.status === 'completed') {
      out.completed.sum += amt
      out.completed.count += 1
    } else if (t.status === 'pending') {
      out.pending.sum += amt
      out.pending.count += 1
    } else if (t.status === 'failed') {
      out.failed.sum += amt
      out.failed.count += 1
    }
  }
  return out
}

function TransactionsPage() {
  const { showToast } = useToast()
  const [transactions, setTransactions] = useState([])
  const [tab, setTab] = useState('all')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')
  const [page, setPage] = useState(1)

  const loadTx = useCallback(async () => {
    try {
      const rows = await getTransactions()
      setTransactions(Array.isArray(rows) ? rows : [])
    } catch (e) {
      showToast('error', e?.message || 'Could not load transactions')
      setTransactions([])
    }
  }, [showToast])

  useEffect(() => {
    loadTx()
  }, [loadTx])

  const todayStats = useMemo(() => computeTodayStats(transactions), [transactions])

  const filtered = useMemo(() => {
    const rows = transactions.filter((t) => {
      if (tab !== 'all' && t.status !== tab) return false
      if (fromDate) {
        const from = startOfDay(new Date(fromDate))
        if (new Date(t.date).getTime() < from.getTime()) return false
      }
      if (toDate) {
        const to = endOfDay(new Date(toDate))
        if (new Date(t.date).getTime() > to.getTime()) return false
      }
      return true
    })
    return [...rows].sort((a, b) => new Date(b.date) - new Date(a.date))
  }, [transactions, tab, fromDate, toDate])

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const safePage = Math.min(page, totalPages)
  const slice = useMemo(() => {
    const start = (safePage - 1) * PAGE_SIZE
    return filtered.slice(start, start + PAGE_SIZE)
  }, [filtered, safePage, page])

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
          </div>
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[880px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700/80 bg-slate-900/60 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3.5 font-semibold">Phone</th>
                  <th className="px-4 py-3.5 font-semibold">Plan</th>
                  <th className="px-4 py-3.5 font-semibold">Amount</th>
                  <th className="px-4 py-3.5 font-semibold">Order ID</th>
                  <th className="px-4 py-3.5 font-semibold">Status</th>
                  <th className="px-4 py-3.5 font-semibold">Date</th>
                </tr>
              </thead>
              <tbody>
                {slice.map((row) => (
                  <tr
                    key={row.id}
                    className="border-b border-slate-800/80 transition-colors hover:bg-slate-900/55"
                  >
                    <td className="px-4 py-3.5 font-mono text-[13px] text-slate-200">
                      {row.phone}
                    </td>
                    <td className="px-4 py-3.5 text-slate-300">{row.plan}</td>
                    <td className="px-4 py-3.5 font-semibold tabular-nums text-amber-100">
                      {formatTsh(row.amount)}
                    </td>
                    <td className="px-4 py-3.5 font-mono text-xs text-slate-400">{row.orderId}</td>
                    <td className="px-4 py-3.5">
                      <span
                        className={`inline-flex rounded-lg px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ${statusBadgeClass(row.status)}`}
                      >
                        {statusLabel(row.status)}
                      </span>
                    </td>
                    <td className="px-4 py-3.5 text-slate-300 tabular-nums">
                      {formatReadableDateTime(row.date)}
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
