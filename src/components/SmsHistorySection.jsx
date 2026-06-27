import { useCallback, useEffect, useMemo, useState } from 'react'
import { Copy, Loader2, RotateCcw, Search, X } from 'lucide-react'
import { useToast } from '../context/ToastContext.jsx'
import { getSmsLog, postSmsLogResend } from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

const PAGE_SIZE = 25

const STATUS_OPTIONS = [
  { id: 'all', label: 'All statuses' },
  { id: 'sent', label: 'Sent' },
  { id: 'failed', label: 'Failed' },
  { id: 'pending', label: 'Pending' },
]

const TRIGGER_OPTIONS = [
  { id: 'all', label: 'All triggers' },
  { id: 'payment_success', label: 'payment_success' },
  { id: 'expiry_reminder', label: 'expiry_reminder' },
  { id: 'expired', label: 'expired' },
  { id: 'admin_broadcast', label: 'admin_broadcast' },
  { id: 'other', label: 'Other' },
]

const DATE_PRESETS = [
  { id: 'all', label: 'All time' },
  { id: 'today', label: 'Today' },
  { id: 'yesterday', label: 'Yesterday' },
  { id: '7d', label: 'Last 7 days' },
]

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function selectClass() {
  return 'rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function statusClass(status) {
  if (status === 'sent') return 'text-emerald-400'
  if (status === 'failed' || status === 'phone_missing') return 'text-red-400'
  if (status === 'pending') return 'text-amber-300'
  return 'text-slate-400'
}

function messagePreview(text, max = 72) {
  const s = String(text ?? '').trim()
  if (!s) return '—'
  if (s.length <= max) return s
  return `${s.slice(0, max)}…`
}

function eatDayBounds(preset) {
  const tz = 'Africa/Dar_es_Salaam'
  const now = new Date()
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const y = Number(parts.find((p) => p.type === 'year')?.value)
  const m = Number(parts.find((p) => p.type === 'month')?.value)
  const d = Number(parts.find((p) => p.type === 'day')?.value)

  const startOfDay = (year, month, day) => {
    const utcGuess = new Date(Date.UTC(year, month - 1, day, 0, 0, 0))
    const offsetMin = Math.round(
      (new Date(utcGuess.toLocaleString('en-US', { timeZone: tz })).getTime() -
        new Date(utcGuess.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()) /
        60_000,
    )
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0) - offsetMin * 60_000)
  }

  const todayStart = startOfDay(y, m, d)
  if (preset === 'today') {
    const end = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000 - 1)
    return { dateFrom: todayStart.toISOString(), dateTo: end.toISOString() }
  }
  if (preset === 'yesterday') {
    const yStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000)
    const yEnd = new Date(todayStart.getTime() - 1)
    return { dateFrom: yStart.toISOString(), dateTo: yEnd.toISOString() }
  }
  if (preset === '7d') {
    const start = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000)
    return { dateFrom: start.toISOString(), dateTo: now.toISOString() }
  }
  return { dateFrom: '', dateTo: '' }
}

async function copyText(text, label, showToast) {
  const value = String(text ?? '').trim()
  if (!value) {
    showToast('error', `No ${label} to copy`)
    return
  }
  try {
    await navigator.clipboard.writeText(value)
    showToast('success', `${label} copied`)
  } catch {
    showToast('error', 'Copy failed')
  }
}

function DetailRow({ label, children }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[140px_1fr] sm:gap-3">
      <dt className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="text-sm text-slate-200 break-all">{children}</dd>
    </div>
  )
}

function SmsDetailModal({ row, onClose, onResent, showToast }) {
  const [resending, setResending] = useState(false)
  if (!row) return null

  const requestId = row.providerRequestId || row.providerMessageId || ''

  async function handleResend() {
    setResending(true)
    try {
      const r = await postSmsLogResend(row.id)
      if (r?.ok) {
        showToast('success', 'SMS resent')
        onResent?.()
        onClose()
      } else {
        showToast('error', r?.error || r?.reason || 'Resend failed')
      }
    } catch (e) {
      showToast('error', e?.message || 'Resend failed')
    } finally {
      setResending(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={resending ? undefined : onClose}
      />
      <div
        className="relative flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-600/50 bg-[#0f172a] shadow-2xl ring-1 ring-amber-500/15"
        role="dialog"
        aria-modal="true"
      >
        <div className="flex items-start justify-between gap-3 border-b border-slate-700/60 px-5 py-4">
          <div>
            <h2 className="text-lg font-semibold text-white">SMS details</h2>
            <p className="mt-0.5 text-xs text-slate-500">#{row.id}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={resending}
            className="rounded-lg p-2 text-slate-400 hover:bg-slate-800 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="custom-scrollbar space-y-4 overflow-y-auto px-5 py-4">
          <dl className="space-y-3">
            <DetailRow label="Recipient">
              <span className="font-mono">{row.recipient || '—'}</span>
              {row.recipient ? (
                <button
                  type="button"
                  onClick={() => copyText(row.recipient, 'Phone number', showToast)}
                  className="ml-2 inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy
                </button>
              ) : null}
            </DetailRow>
            <DetailRow label="Trigger">{row.triggerType || row.templateKey || row.smsType || '—'}</DetailRow>
            <DetailRow label="Status">
              <span className={statusClass(row.status)}>{row.status}</span>
            </DetailRow>
            <DetailRow label="Sent time">
              {row.createdAt ? formatAdminDateTime(row.createdAt) : '—'}
            </DetailRow>
            {requestId ? (
              <DetailRow label="Provider request">
                <span className="font-mono text-xs">{requestId}</span>
                <button
                  type="button"
                  onClick={() => copyText(requestId, 'Request ID', showToast)}
                  className="ml-2 inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
                >
                  <Copy className="h-3.5 w-3.5" /> Copy
                </button>
              </DetailRow>
            ) : null}
            {row.paymentId ? <DetailRow label="Payment ID">{row.paymentId}</DetailRow> : null}
            {row.subscriptionId ? <DetailRow label="Subscription ID">{row.subscriptionId}</DetailRow> : null}
            {row.deviceId ? <DetailRow label="Device ID">{row.deviceId}</DetailRow> : null}
          </dl>

          <div>
            <div className="mb-2 flex items-center justify-between gap-2">
              <p className={labelClass()}>Message</p>
              <button
                type="button"
                onClick={() => copyText(row.message, 'Message', showToast)}
                className="inline-flex items-center gap-1 text-xs text-amber-400 hover:text-amber-300"
              >
                <Copy className="h-3.5 w-3.5" /> Copy message
              </button>
            </div>
            <pre className="whitespace-pre-wrap rounded-xl border border-slate-700/60 bg-slate-950/60 p-4 text-sm leading-relaxed text-slate-200">
              {row.message || '—'}
            </pre>
          </div>
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-slate-700/60 px-5 py-4">
          {row.status === 'failed' ? (
            <button
              type="button"
              onClick={handleResend}
              disabled={resending}
              className="inline-flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-sm font-semibold text-amber-200 disabled:opacity-50"
            >
              {resending ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
              Resend
            </button>
          ) : null}
          <button
            type="button"
            onClick={onClose}
            disabled={resending}
            className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  )
}

export default function SmsHistorySection() {
  const { showToast } = useToast()
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('all')
  const [trigger, setTrigger] = useState('all')
  const [datePreset, setDatePreset] = useState('all')
  const [page, setPage] = useState(0)

  const [logs, setLogs] = useState([])
  const [logTotal, setLogTotal] = useState(0)
  const [logsLoading, setLogsLoading] = useState(false)
  const [selected, setSelected] = useState(null)

  const dateRange = useMemo(() => eatDayBounds(datePreset), [datePreset])

  useEffect(() => {
    const t = window.setTimeout(() => {
      setSearch(searchInput.trim())
      setPage(0)
    }, 300)
    return () => window.clearTimeout(t)
  }, [searchInput])

  const loadLogs = useCallback(async () => {
    setLogsLoading(true)
    try {
      const r = await getSmsLog({
        limit: PAGE_SIZE,
        offset: page * PAGE_SIZE,
        search,
        status,
        trigger,
        date_from: dateRange.dateFrom || undefined,
        date_to: dateRange.dateTo || undefined,
      })
      setLogs(Array.isArray(r?.rows) ? r.rows : [])
      setLogTotal(Number(r?.total) || 0)
    } catch (e) {
      showToast('error', e?.message || 'Could not load SMS log')
    } finally {
      setLogsLoading(false)
    }
  }, [search, status, trigger, dateRange.dateFrom, dateRange.dateTo, page, showToast])

  useEffect(() => {
    void loadLogs()
  }, [loadLogs])

  const pageCount = Math.max(1, Math.ceil(logTotal / PAGE_SIZE))
  const from = logTotal === 0 ? 0 : page * PAGE_SIZE + 1
  const to = Math.min(logTotal, (page + 1) * PAGE_SIZE)

  function resetFilters() {
    setSearchInput('')
    setSearch('')
    setStatus('all')
    setTrigger('all')
    setDatePreset('all')
    setPage(0)
  }

  return (
    <div className="space-y-4">
      <div className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-4">
        <div className="grid gap-3 lg:grid-cols-[1fr_auto_auto_auto] lg:items-end">
          <div>
            <label className={labelClass()}>Search</label>
            <div className="relative">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                placeholder="Phone, message, trigger, status…"
                className={`${inputClass()} pl-9`}
              />
            </div>
          </div>
          <div>
            <label className={labelClass()}>Status</label>
            <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(0) }} className={selectClass()}>
              {STATUS_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass()}>Trigger</label>
            <select value={trigger} onChange={(e) => { setTrigger(e.target.value); setPage(0) }} className={selectClass()}>
              {TRIGGER_OPTIONS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelClass()}>Date</label>
            <select value={datePreset} onChange={(e) => { setDatePreset(e.target.value); setPage(0) }} className={selectClass()}>
              {DATE_PRESETS.map((o) => (
                <option key={o.id} value={o.id}>{o.label}</option>
              ))}
            </select>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-slate-500">
            {logTotal} matching {logTotal === 1 ? 'entry' : 'entries'}
            {search ? ` · search “${search}”` : ''}
          </p>
          <div className="flex gap-2">
            <button type="button" onClick={resetFilters} className="text-xs text-slate-400 hover:text-slate-200">
              Clear filters
            </button>
            <button
              type="button"
              onClick={() => void loadLogs()}
              disabled={logsLoading}
              className="text-xs text-amber-400 hover:text-amber-300"
            >
              Refresh
            </button>
          </div>
        </div>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-slate-700/60 bg-slate-950/40">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-slate-900/80 text-xs uppercase text-slate-500">
            <tr>
              <th className="px-4 py-3">Time</th>
              <th className="px-4 py-3">Recipient</th>
              <th className="px-4 py-3">Trigger</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Message</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/80">
            {logs.map((row) => (
              <tr
                key={row.id}
                onClick={() => setSelected(row)}
                className="cursor-pointer text-slate-300 transition-colors hover:bg-slate-900/50"
              >
                <td className="whitespace-nowrap px-4 py-3 text-xs">
                  {row.createdAt ? formatAdminDateTime(row.createdAt) : '—'}
                </td>
                <td className="px-4 py-3 font-mono text-xs">{row.recipient || '—'}</td>
                <td className="px-4 py-3 text-xs">{row.triggerType || row.templateKey || row.smsType || '—'}</td>
                <td className="px-4 py-3">
                  <span className={statusClass(row.status)}>{row.status}</span>
                </td>
                <td className="max-w-xs px-4 py-3 text-xs text-slate-400">{messagePreview(row.message)}</td>
              </tr>
            ))}
            {logs.length === 0 && !logsLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-8 text-center text-slate-500">
                  No SMS matching your filters
                </td>
              </tr>
            ) : null}
            {logsLoading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-slate-500">
                  <Loader2 className="mx-auto h-5 w-5 animate-spin text-amber-400" />
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-700/60 px-4 py-3">
          <p className="text-xs text-slate-500">
            Showing {from}–{to} of {logTotal}
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 0 || logsLoading}
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-40"
            >
              Previous
            </button>
            <span className="text-xs text-slate-500">
              Page {page + 1} / {pageCount}
            </span>
            <button
              type="button"
              disabled={page + 1 >= pageCount || logsLoading}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs text-slate-300 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      <SmsDetailModal
        row={selected}
        onClose={() => setSelected(null)}
        onResent={loadLogs}
        showToast={showToast}
      />
    </div>
  )
}
