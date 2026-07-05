import { useCallback, useEffect, useRef, useState } from 'react'
import { HandHelping, RefreshCw, ToggleLeft, ToggleRight } from 'lucide-react'
import Topbar from '../components/Topbar'
import SecurityPinModal from '../components/SecurityPinModal'
import { useToast } from '../context/ToastContext.jsx'
import {
  getPlans,
  getSubscriptionRequests,
  getSubscriptionRequestSettings,
  postSubscriptionRequestApprove,
  postSubscriptionRequestBlock,
  postSubscriptionRequestReject,
  putSubscriptionRequestSettings,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'
import { formatTsh } from '../lib/formatMoney'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'PENDING', label: 'Pending' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'REJECTED', label: 'Rejected' },
  { id: 'BLOCKED', label: 'Blocked' },
]

function statusBadge(status) {
  const s = String(status ?? '').toUpperCase()
  const map = {
    PENDING: 'bg-amber-500/15 text-amber-100 ring-amber-400/40',
    APPROVED: 'bg-emerald-500/15 text-emerald-200 ring-emerald-500/30',
    REJECTED: 'bg-rose-500/15 text-rose-200 ring-rose-500/30',
    BLOCKED: 'bg-slate-600/40 text-slate-300 ring-slate-500/25',
  }
  return map[s] || map.PENDING
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-400/50 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

export default function SubscriptionRequestsPage() {
  const { showToast } = useToast()
  const cached = readAdminSnapshot('subscription-requests')
  const [rows, setRows] = useState(Array.isArray(cached?.rows) ? cached.rows : [])
  const [plans, setPlans] = useState(Array.isArray(cached?.plans) ? cached.plans : [])
  const [enabled, setEnabled] = useState(cached?.enabled !== false)
  const [initialLoading, setInitialLoading] = useState(!Array.isArray(cached?.rows))
  const [refreshing, setRefreshing] = useState(false)
  const hasRowsRef = useRef(Array.isArray(cached?.rows))
  const genRef = useRef(0)
  const [tab, setTab] = useState('PENDING')
  const [search, setSearch] = useState('')
  const [editPlan, setEditPlan] = useState({})
  const [pinExec, setPinExec] = useState(null)
  const [pinBusy, setPinBusy] = useState(false)
  const [pinError, setPinError] = useState('')

  const load = useCallback(async () => {
    const gen = ++genRef.current
    const isFirst = !hasRowsRef.current
    if (isFirst) setInitialLoading(true)
    else setRefreshing(true)
    try {
      const [data, settings, plansRes] = await Promise.all([
        getSubscriptionRequests({ status: tab, search: search.trim() }),
        getSubscriptionRequestSettings(),
        getPlans(),
      ])
      if (gen !== genRef.current) return
      const list = Array.isArray(data?.rows) ? data.rows : []
      const planList = Array.isArray(plansRes) ? plansRes.filter((p) => p?.isActive !== false) : []
      setRows(list)
      setEnabled(settings?.enabled !== false)
      setPlans(planList)
      hasRowsRef.current = true
      writeAdminSnapshot('subscription-requests', {
        rows: list,
        plans: planList,
        enabled: settings?.enabled !== false,
      })
    } catch (e) {
      if (gen !== genRef.current) return
      showToast(e.message || 'Failed to load requests', 'error')
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

  const toggleFeature = () => {
    setPinExec(() => async (pin) => {
      setPinBusy(true)
      setPinError('')
      try {
        await putSubscriptionRequestSettings({ pin, enabled: !enabled })
        setEnabled(!enabled)
        showToast(!enabled ? 'OMBA KIFURUSHI enabled' : 'OMBA KIFURUSHI disabled', 'success')
      } catch (e) {
        setPinError(e.message || 'Failed')
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
            <div className="rounded-2xl bg-violet-500/10 p-3 ring-1 ring-violet-500/20">
              <HandHelping className="h-6 w-6 text-violet-300" />
            </div>
            <div>
              <h1 className="text-xl font-bold text-white">Omba Kifurushi Requests</h1>
              <p className="text-sm text-slate-400">User subscription requests from the app</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={toggleFeature}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600/70 bg-slate-900/80 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              {enabled ? <ToggleRight className="h-4 w-4 text-emerald-400" /> : <ToggleLeft className="h-4 w-4 text-rose-400" />}
              {enabled ? 'Enabled' : 'Disabled'}
            </button>
            <button
              type="button"
              onClick={load}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600/70 bg-slate-900/80 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800"
            >
              <RefreshCw className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>
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
            placeholder="Search device ID, phone, request ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        <div className="overflow-x-auto rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <table className="min-w-[1100px] w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">ID</th>
                <th className="px-4 py-3">Device</th>
                <th className="px-4 py-3">Phone</th>
                <th className="px-4 py-3">Package</th>
                <th className="px-4 py-3">Price</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Requested (EAT)</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/80">
              {initialLoading ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                    No requests
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-900/40">
                    <td className="px-4 py-3">{row.id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-400">{String(row.deviceId ?? '').slice(0, 16)}…</td>
                    <td className="px-4 py-3">{row.phone}</td>
                    <td className="px-4 py-3">
                      {row.status === 'PENDING' ? (
                        <select
                          className="rounded-lg border border-slate-600 bg-slate-900 px-2 py-1 text-xs"
                          value={editPlan[row.id] ?? row.planId}
                          onChange={(e) => setEditPlan((p) => ({ ...p, [row.id]: Number(e.target.value) }))}
                        >
                          {plans.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name} ({p.durationDays ?? p.duration_days}d)
                            </option>
                          ))}
                        </select>
                      ) : (
                        row.planName
                      )}
                    </td>
                    <td className="px-4 py-3">{formatTsh(row.price)}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ${statusBadge(row.status)}`}>
                        {row.status}
                      </span>
                    </td>
                    <td className="px-4 py-3">{formatAdminDateTime(row.createdAt)}</td>
                    <td className="px-4 py-3">
                      {row.status === 'PENDING' && (
                        <div className="flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() =>
                              setPinExec(() => async (pin) => {
                                await postSubscriptionRequestApprove(row.id, {
                                  pin,
                                  confirm: true,
                                  plan_id: editPlan[row.id] ?? row.planId,
                                })
                                showToast(`Request #${row.id} approved`, 'success')
                                await load()
                              })
                            }
                            className="rounded-lg bg-emerald-600/90 px-3 py-1 text-xs font-semibold text-white"
                          >
                            Approve
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPinExec(() => async (pin) => {
                                await postSubscriptionRequestReject(row.id, { pin, reason: 'Rejected by admin' })
                                showToast('Rejected', 'info')
                                await load()
                              })
                            }
                            className="rounded-lg bg-rose-600/70 px-3 py-1 text-xs font-semibold text-white"
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            onClick={() =>
                              setPinExec(() => async (pin) => {
                                await postSubscriptionRequestBlock(row.id, { pin, reason: 'Blocked by admin' })
                                showToast('Blocked', 'info')
                                await load()
                              })
                            }
                            className="rounded-lg bg-slate-600 px-3 py-1 text-xs font-semibold text-white"
                          >
                            Block
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      <SecurityPinModal
        open={pinExec != null}
        title="Ingiza Security PIN"
        errorText={pinError}
        busy={pinBusy}
        onClose={() => {
          setPinExec(null)
          setPinError('')
        }}
        onSubmit={async (pin) => {
          if (pinExec) await pinExec(pin)
          setPinExec(null)
        }}
      />
    </>
  )
}
