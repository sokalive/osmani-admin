import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ClipboardList, RefreshCw, ShieldCheck } from 'lucide-react'
import Topbar from '../components/Topbar'
import SecurityPinModal from '../components/SecurityPinModal'
import { useToast } from '../context/ToastContext.jsx'
import {
  getPaymentOrders,
  postPaymentOrderApproveRecovery,
  postPaymentOrderReconcile,
  postPaymentOrderRejectRecovery,
  syncStreamUrl,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'
import { formatTsh } from '../lib/formatMoney'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

const SSE_DEBOUNCE_MS = 1200

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

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

export default function PaymentOrdersPage() {
  const { showToast } = useToast()
  const cached = readAdminSnapshot('payment-orders')
  const [rows, setRows] = useState(Array.isArray(cached?.rows) ? cached.rows : [])
  const [initialLoading, setInitialLoading] = useState(!Array.isArray(cached?.rows))
  const [refreshing, setRefreshing] = useState(false)
  const hasRowsRef = useRef(Array.isArray(cached?.rows))
  const genRef = useRef(0)
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const [pinExec, setPinExec] = useState(null)
  const [pinBusy, setPinBusy] = useState(false)
  const [pinError, setPinError] = useState('')
  const [confirmRow, setConfirmRow] = useState(null)

  const load = useCallback(async () => {
    const gen = ++genRef.current
    const isFirst = !hasRowsRef.current
    if (isFirst) setInitialLoading(true)
    else setRefreshing(true)
    try {
      const data = await getPaymentOrders({ status: tab, search: search.trim() })
      if (gen !== genRef.current) return
      const list = Array.isArray(data?.rows) ? data.rows : []
      setRows(list)
      hasRowsRef.current = true
      writeAdminSnapshot('payment-orders', { rows: list, tab, search: search.trim() })
    } catch (e) {
      if (gen !== genRef.current) return
      showToast(e.message || 'Failed to load payment orders', 'error')
    } finally {
      if (gen === genRef.current) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }, [tab, search, showToast])

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

  const filtered = useMemo(() => rows, [rows])

  const runApprove = (row) => {
    setConfirmRow(row)
    setPinExec(() => async (pin) => {
      setPinBusy(true)
      setPinError('')
      try {
        await postPaymentOrderApproveRecovery(row.orderId, {
          pin,
          confirm: true,
          reason: 'Admin payment recovery approval',
        })
        showToast(`Order ${row.orderId} recovered`, 'success')
        setConfirmRow(null)
        await load()
      } catch (e) {
        setPinError(e.message || 'Approve failed')
        throw e
      } finally {
        setPinBusy(false)
      }
    })
  }

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
              <p className="text-sm text-slate-400">All payment attempts — admin recovery approval</p>
            </div>
          </div>
          <button
            type="button"
            onClick={load}
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
                onClick={() => setTab(t.id)}
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
          <input
            className={inputClass()}
            placeholder="Search order ID, phone, device ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="overflow-x-auto rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <table className="min-w-[1200px] w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">Order ID</th>
                <th className="px-4 py-3">Provider</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Network</th>
                <th className="px-4 py-3">Plan</th>
                <th className="px-4 py-3">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Created (EAT)</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {initialLoading ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                    Loading…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-4 py-8 text-center text-slate-400">
                    No payment orders found
                  </td>
                </tr>
              ) : (
                filtered.map((row) => (
                  <tr key={row.orderId} className="hover:bg-slate-900/40">
                    <td className="px-4 py-3 font-mono text-xs text-amber-100/90">{row.orderId}</td>
                    <td className="px-4 py-3">{row.provider}</td>
                    <td className="px-4 py-3">{row.phone || '—'}</td>
                    <td className="px-4 py-3 text-slate-400">{row.mobileNetwork || '—'}</td>
                    <td className="px-4 py-3">{row.planName || '—'}</td>
                    <td className="px-4 py-3">{formatTsh(row.amount)}</td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ${ledgerBadgeClass(row.ledgerStatus)}`}
                      >
                        {row.ledgerStatus}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{row.deviceIdMasked || '—'}</td>
                    <td className="px-4 py-3 text-slate-300">{formatAdminDateTime(row.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        {row.ledgerStatus !== 'MANUALLY_APPROVED' && row.ledgerStatus !== 'SUCCESS' && (
                          <button
                            type="button"
                            onClick={() => runApprove(row)}
                            className="rounded-lg bg-emerald-600/90 px-3 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                          >
                            Approve
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
        </div>

        {confirmRow && (
          <div className="rounded-2xl border border-amber-500/30 bg-slate-900/90 p-4 text-sm text-slate-200">
            <div className="mb-2 flex items-center gap-2 font-semibold text-amber-200">
              <ShieldCheck className="h-4 w-4" /> Confirm recovery
            </div>
            <p>Phone: {confirmRow.phone}</p>
            <p>Device: {confirmRow.deviceId || confirmRow.deviceIdMasked}</p>
            <p>Order: {confirmRow.orderId}</p>
            <p>Provider: {confirmRow.provider}</p>
            <p>Amount: {formatTsh(confirmRow.amount)}</p>
            <p>Plan: {confirmRow.planName}</p>
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
        }}
        onSubmit={async (pin) => {
          if (pinExec) await pinExec(pin)
          setPinExec(null)
        }}
      />
    </>
  )
}
