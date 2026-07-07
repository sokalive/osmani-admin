import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { HandHelping, RefreshCw, ToggleLeft, ToggleRight, Trash2 } from 'lucide-react'
import Topbar from '../components/Topbar'
import AdminDeviceIdCell from '../components/AdminDeviceIdCell'
import SecurityPinModal from '../components/SecurityPinModal'
import { useToast } from '../context/ToastContext.jsx'
import {
  getPlans,
  getSubscriptionRequests,
  getSubscriptionRequestSettings,
  postSubscriptionRequestApprove,
  postSubscriptionRequestBlock,
  postSubscriptionRequestDelete,
  postSubscriptionRequestReject,
  postSubscriptionRequestsBulkDelete,
  putSubscriptionRequestSettings,
  syncStreamUrl,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'
import { formatTsh } from '../lib/formatMoney'
import { shouldReplaceRows } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

const SSE_DEBOUNCE_MS = 1200

const STATUS_TABS = [
  { id: 'all', label: 'All' },
  { id: 'PENDING', label: 'Pending' },
  { id: 'APPROVED', label: 'Approved' },
  { id: 'REJECTED', label: 'Rejected' },
  { id: 'BLOCKED', label: 'Blocked' },
]

const EMPTY_COUNTS = { all: 0, PENDING: 0, APPROVED: 0, REJECTED: 0, BLOCKED: 0 }

function cacheKey(tab, search) {
  return `subscription-requests:${tab}:${String(search ?? '').trim() || '_'}`
}

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

function hydrateTab(tab, search) {
  const snap = readAdminSnapshot(cacheKey(tab, search))
  return {
    rows: Array.isArray(snap?.rows) ? snap.rows : [],
    counts: snap?.statusCounts && typeof snap.statusCounts === 'object' ? snap.statusCounts : null,
    plans: Array.isArray(snap?.plans) ? snap.plans : [],
    enabled: snap?.enabled !== false,
    fromCache: Boolean(snap?.rows),
  }
}

export default function SubscriptionRequestsPage() {
  const { showToast } = useToast()
  const [tab, setTab] = useState('all')
  const [search, setSearch] = useState('')
  const initial = useMemo(() => hydrateTab('all', ''), [])
  const [rows, setRows] = useState(initial.rows)
  const rowsRef = useRef(initial.rows)
  rowsRef.current = rows
  const [statusCounts, setStatusCounts] = useState(initial.counts ?? EMPTY_COUNTS)
  const [plans, setPlans] = useState(initial.plans)
  const [enabled, setEnabled] = useState(initial.enabled)
  const [initialLoading, setInitialLoading] = useState(!initial.fromCache)
  const [refreshing, setRefreshing] = useState(false)
  const hasRowsRef = useRef(initial.fromCache)
  const genRef = useRef(0)
  const [editPlan, setEditPlan] = useState({})
  const [pinExec, setPinExec] = useState(null)
  const [pinBusy, setPinBusy] = useState(false)
  const [pinError, setPinError] = useState('')
  const [selected, setSelected] = useState(() => new Set())
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingBulkDelete, setPendingBulkDelete] = useState(false)

  useEffect(() => {
    setSelected(new Set())
    const snap = hydrateTab(tab, search)
    setRows(snap.rows)
    rowsRef.current = snap.rows
    if (snap.counts) setStatusCounts(snap.counts)
    hasRowsRef.current = snap.fromCache && snap.rows.length > 0
    setInitialLoading(!snap.fromCache)
  }, [tab, search])

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
      const counts =
        data?.statusCounts && typeof data.statusCounts === 'object'
          ? { ...EMPTY_COUNTS, ...data.statusCounts }
          : statusCounts
      if (!shouldReplaceRows(rowsRef.current, list, { allowEmpty: true })) return
      setRows(list)
      rowsRef.current = list
      setStatusCounts(counts)
      setEnabled(settings?.enabled !== false)
      setPlans(planList)
      hasRowsRef.current = true
      writeAdminSnapshot(cacheKey(tab, search), {
        rows: list,
        statusCounts: counts,
        plans: planList,
        enabled: settings?.enabled !== false,
        tab,
        search: search.trim(),
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

  useEffect(() => {
    const url = syncStreamUrl(['config'])
    const es = new EventSource(url)
    let debounceId = null
    const onRefresh = () => {
      window.clearTimeout(debounceId)
      debounceId = window.setTimeout(() => load(), SSE_DEBOUNCE_MS)
    }
    es.addEventListener('subscription_request_updated', onRefresh)
    es.onmessage = onRefresh
    return () => {
      window.clearTimeout(debounceId)
      es.close()
    }
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

  const visibleIds = useMemo(() => rows.map((r) => r.id), [rows])
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))
  const selectedCount = selected.size

  function toggleRow(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAllVisible() {
    setSelected((prev) => {
      if (allVisibleSelected) return new Set()
      return new Set(visibleIds)
    })
  }

  function removeRowsLocally(ids) {
    const idSet = new Set(ids.map(Number))
    setRows((prev) => {
      const next = prev.filter((r) => !idSet.has(Number(r.id)))
      rowsRef.current = next
      writeAdminSnapshot(cacheKey(tab, search), {
        rows: next,
        statusCounts,
        plans,
        enabled,
        tab,
        search: search.trim(),
      })
      return next
    })
    setSelected((prev) => {
      const next = new Set(prev)
      for (const id of idSet) next.delete(id)
      return next
    })
  }

  function confirmSingleDelete(row) {
    setPendingDelete(row)
  }

  function confirmBulkDeleteAction() {
    if (selectedCount === 0) return
    setPendingBulkDelete(true)
  }

  function runSingleDeleteWithPin(row) {
    setPinExec(() => async (pin) => {
      setPinBusy(true)
      setPinError('')
      try {
        await postSubscriptionRequestDelete(row.id, { pin })
        removeRowsLocally([row.id])
        showToast(`Request #${row.id} deleted`, 'success')
        await load()
      } catch (e) {
        setPinError(e.message || 'Delete failed')
        throw e
      } finally {
        setPinBusy(false)
      }
    })
  }

  function runBulkDeleteWithPin() {
    const ids = [...selected]
    setPinExec(() => async (pin) => {
      setPinBusy(true)
      setPinError('')
      try {
        const out = await postSubscriptionRequestsBulkDelete({ pin, request_ids: ids })
        removeRowsLocally(out?.deletedIds ?? ids)
        showToast(`Deleted ${out?.deleted ?? ids.length} request(s)`, 'success')
        await load()
      } catch (e) {
        setPinError(e.message || 'Bulk delete failed')
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
            {STATUS_TABS.map((t) => {
              const countKey = t.id === 'all' ? 'all' : t.id
              const n = Number(statusCounts[countKey]) || 0
              return (
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
                  <span className="ml-1.5 tabular-nums opacity-80">({n})</span>
                </button>
              )
            })}
          </div>
          <input
            className={inputClass()}
            placeholder="Search device ID, phone, request ID…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>

        {selectedCount > 0 ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-100">
            <span>{selectedCount} selected</span>
            <button
              type="button"
              onClick={() => setSelected(new Set())}
              className="rounded-lg border border-amber-500/40 px-3 py-1 text-xs hover:bg-amber-500/20"
            >
              Clear selection
            </button>
            <button
              type="button"
              onClick={confirmBulkDeleteAction}
              className="inline-flex items-center gap-1 rounded-lg bg-rose-600/80 px-3 py-1 text-xs font-semibold text-white hover:bg-rose-600"
            >
              <Trash2 className="h-3.5 w-3.5" /> Delete selected
            </button>
          </div>
        ) : null}

        <div className="overflow-x-auto rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <table className="min-w-[1180px] w-full border-collapse text-left text-sm">
            <thead>
              <tr className="border-b border-slate-700/60 bg-slate-900/60 text-xs uppercase tracking-wide text-slate-400">
                <th className="px-4 py-3">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAllVisible}
                    aria-label="Select all visible rows"
                  />
                </th>
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
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-slate-400">
                    No requests
                  </td>
                </tr>
              ) : (
                rows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-900/40">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(row.id)}
                        onChange={() => toggleRow(row.id)}
                        aria-label={`Select request ${row.id}`}
                      />
                    </td>
                    <td className="px-4 py-3">{row.id}</td>
                    <td className="px-4 py-3 max-w-[14rem]">
                      <AdminDeviceIdCell deviceId={row.deviceId} />
                    </td>
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
                      <div className="flex flex-wrap gap-2">
                        {row.status === 'PENDING' && (
                          <>
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
                          </>
                        )}
                        <button
                          type="button"
                          onClick={() => confirmSingleDelete(row)}
                          className="inline-flex items-center gap-1 rounded-lg border border-rose-500/40 bg-rose-950/40 px-3 py-1 text-xs font-semibold text-rose-200 hover:bg-rose-900/50"
                        >
                          <Trash2 className="h-3 w-3" /> Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </main>

      {pendingDelete ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            aria-label="Close"
            onClick={() => setPendingDelete(null)}
          />
          <div className="relative w-full max-w-md rounded-2xl border border-slate-600/60 bg-[#0b1220] p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-white">Delete request #{pendingDelete.id}?</h2>
            <p className="mt-2 text-sm text-slate-400">
              Delete this request record? The user&apos;s active subscription/package will not be removed.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingDelete(null)}
                className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  const row = pendingDelete
                  setPendingDelete(null)
                  runSingleDeleteWithPin(row)
                }}
                className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pendingBulkDelete ? (
        <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
          <button
            type="button"
            className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            aria-label="Close"
            onClick={() => setPendingBulkDelete(false)}
          />
          <div className="relative w-full max-w-md rounded-2xl border border-slate-600/60 bg-[#0b1220] p-6 shadow-2xl">
            <h2 className="text-lg font-bold text-white">Delete {selectedCount} request(s)?</h2>
            <p className="mt-2 text-sm text-slate-400">
              Only the selected request records will be removed. Active subscriptions for these users are not affected.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setPendingBulkDelete(false)}
                className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => {
                  setPendingBulkDelete(false)
                  runBulkDeleteWithPin()
                }}
                className="rounded-xl bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-500"
              >
                Continue
              </button>
            </div>
          </div>
        </div>
      ) : null}

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
