import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Ban,
  Copy,
  KeyRound,
  Plus,
  Search,
  Trash2,
} from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  deleteTransferCode,
  getTransferCodes,
  postTransferCode,
  postTransferCodesBulkDelete,
  syncStreamUrl,
  putTransferCode,
} from '../lib/api'
import { formatReadableDateTime } from '../lib/formatTxDisplay'
import { shouldReplaceRows } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

function effectiveStatus(row, nowMs) {
  if (row.status === 'revoked' || row.status === 'used') return row.status
  if (row.status === 'expired') return 'expired'
  if (new Date(row.expiresAt).getTime() <= nowMs) return 'expired'
  return 'active'
}

function formatCountdown(expiresAt, nowMs) {
  const end = new Date(expiresAt).getTime()
  const ms = end - nowMs
  if (ms <= 0) return 'Expired'
  const s = Math.floor(ms / 1000)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  if (h > 48) return `${Math.floor(h / 24)}d ${h % 24}h`
  if (h > 0) return `${h}h ${m}m ${sec}s`
  if (m > 0) return `${m}m ${sec}s`
  return `${sec}s`
}

function badgeClass(st) {
  switch (st) {
    case 'active':
      return 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/45'
    case 'used':
      return 'bg-sky-500/20 text-sky-100 ring-sky-400/45'
    case 'revoked':
      return 'bg-amber-500/20 text-amber-100 ring-amber-400/45'
    default:
      return 'bg-slate-600/40 text-slate-300 ring-slate-500/50'
  }
}

function TransferCodesPage() {
  const { showToast } = useToast()
  const cached = readAdminSnapshot('transfer-codes')
  const initialCodes = Array.isArray(cached?.rows) ? cached.rows : []
  const [codes, setCodes] = useState(initialCodes)
  const codesRef = useRef(initialCodes)
  codesRef.current = codes
  const loadGenRef = useRef(0)
  const [nowTick, setNowTick] = useState(() => Date.now())
  const [search, setSearch] = useState('')
  const [flash, setFlash] = useState(null)
  const [selected, setSelected] = useState(() => new Set())

  const loadCodes = useCallback(async () => {
    const gen = ++loadGenRef.current
    try {
      const list = await getTransferCodes()
      if (gen !== loadGenRef.current) return
      const next = Array.isArray(list) ? list : []
      if (shouldReplaceRows(codesRef.current, next)) setCodes(next)
      writeAdminSnapshot('transfer-codes', { rows: next })
    } catch (e) {
      if (gen !== loadGenRef.current) return
      showToast('error', e?.message || 'Could not load transfer codes')
    }
  }, [showToast])

  useEffect(() => {
    loadCodes()
  }, [loadCodes])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onRefresh = () => {
      void loadCodes()
    }
    es.addEventListener('transfer_requested', onRefresh)
    es.addEventListener('transfer_completed', onRefresh)
    es.addEventListener('transfer_rejected', onRefresh)
    es.addEventListener('transfer_codes_changed', onRefresh)
    return () => es.close()
  }, [loadCodes])

  useEffect(() => {
    const t = window.setInterval(() => {
      setNowTick(Date.now())
    }, 1000)
    return () => window.clearInterval(t)
  }, [])

  const withEffective = useMemo(
    () =>
      codes.map((c) => ({
        ...c,
        displayStatus: effectiveStatus(c, nowTick),
      })),
    [codes, nowTick],
  )

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return withEffective
    return withEffective.filter(
      (c) =>
        c.code.toLowerCase().includes(q) ||
        (c.deviceUser && c.deviceUser.toLowerCase().includes(q)),
    )
  }, [withEffective, search])

  const stats = useMemo(() => {
    let active = 0
    let used = 0
    let expired = 0
    for (const c of withEffective) {
      const st = c.displayStatus
      if (st === 'active') active += 1
      if (st === 'used') used += 1
      if (st === 'expired') expired += 1
    }
    return { total: codes.length, active, used, expired }
  }, [withEffective, codes.length])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 3200)
  }

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function toggleAll() {
    setSelected((prev) => {
      if (prev.size === filtered.length) return new Set()
      return new Set(filtered.map((r) => r.id))
    })
  }

  const copyCode = useCallback(async (code) => {
    try {
      await navigator.clipboard.writeText(code)
      showFlash('success', 'Code copied to clipboard.')
    } catch {
      showFlash('error', 'Could not copy — check browser permissions.')
    }
  }, [])

  async function revoke(cid) {
    const c = codes.find((x) => x.id === cid)
    if (!c || c.status !== 'active') return
    if (new Date(c.expiresAt).getTime() <= Date.now()) return
    try {
      await putTransferCode(cid, { ...c, status: 'revoked' })
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(cid)
        return next
      })
      await loadCodes()
      showFlash('success', 'Code revoked.')
    } catch (e) {
      showToast('error', e?.message || 'Revoke failed')
    }
  }

  async function generateOne() {
    try {
      await postTransferCode({ deviceUser: 'Unassigned device', hours: 24 })
      await loadCodes()
      showFlash('success', 'New transfer code generated.')
    } catch (e) {
      showToast('error', e?.message || 'Generate failed')
    }
  }

  async function deleteOne(id) {
    try {
      await deleteTransferCode(id)
      setSelected((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      await loadCodes()
      showFlash('success', 'Code deleted.')
    } catch (e) {
      showToast('error', e?.message || 'Delete failed')
    }
  }

  async function deleteSelected() {
    if (selected.size === 0) return
    if (!window.confirm(`Delete ${selected.size} selected codes?`)) return
    try {
      const out = await postTransferCodesBulkDelete({ ids: Array.from(selected) })
      if (!out?.deleted) {
        showFlash('error', 'No codes deleted. Refresh and retry.')
        return
      }
      setSelected(new Set())
      await loadCodes()
      showFlash('success', 'Selected codes deleted.')
    } catch (e) {
      showToast('error', e?.message || 'Bulk delete failed')
    }
  }

  async function deleteAll() {
    if (!window.confirm('Delete ALL transfer codes history?')) return
    try {
      const out = await postTransferCodesBulkDelete({ all: true })
      if (typeof out?.deleted === 'number' && out.deleted === 0 && codes.length > 0) {
        showFlash('error', 'Delete-all affected 0 rows.')
        return
      }
      setSelected(new Set())
      await loadCodes()
      showFlash('success', 'All transfer codes deleted.')
    } catch (e) {
      showToast('error', e?.message || 'Delete all failed')
    }
  }

  async function cleanupExpired() {
    try {
      const out = await postTransferCodesBulkDelete({ all: true, expiredOnly: true })
      if (typeof out?.deleted === 'number' && out.deleted === 0) {
        showFlash('success', 'No expired codes to clean.')
        return
      }
      await loadCodes()
      showFlash('success', 'Expired codes cleaned up.')
    } catch (e) {
      showToast('error', e?.message || 'Expired cleanup failed')
    }
  }

  const labelForStatus = (st) => {
    if (st === 'active') return 'Active'
    if (st === 'used') return 'Used'
    if (st === 'revoked') return 'Revoked'
    return 'Expired'
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Transfer Codes
            </h1>
            <p className="mt-1 text-sm text-slate-400">
              One-time transfer tokens for immediate ownership move
            </p>
          </div>
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <div className="relative min-w-[240px] flex-1">
              <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search code or device…"
                className="w-full rounded-xl border border-slate-600/70 bg-slate-900/80 py-2.5 pl-10 pr-4 text-sm text-white placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25"
              />
            </div>
            <button
              type="button"
              onClick={generateOne}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-5 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)]"
            >
              <Plus className="h-4 w-4" />
              Generate Code
            </button>
            <button
              type="button"
              onClick={cleanupExpired}
              className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-600 px-4 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800"
            >
              Cleanup Expired
            </button>
          </div>
        </header>

        <section className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div className="rounded-2xl border border-slate-700/60 bg-slate-900/50 p-5 ring-1 ring-white/[0.04]">
            <div className="flex items-center gap-2 text-slate-400">
              <KeyRound className="h-5 w-5 text-amber-400" />
              <span className="text-xs font-semibold uppercase tracking-wide">Total Codes</span>
            </div>
            <p className="mt-3 text-3xl font-bold text-white">{stats.total}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/30 bg-emerald-950/25 p-5 ring-1 ring-emerald-500/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400/90">
              Active Codes
            </p>
            <p className="mt-3 text-3xl font-bold text-emerald-100">{stats.active}</p>
          </div>
          <div className="rounded-2xl border border-sky-500/30 bg-sky-950/25 p-5 ring-1 ring-sky-500/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-sky-400/90">Used Codes</p>
            <p className="mt-3 text-3xl font-bold text-sky-100">{stats.used}</p>
          </div>
          <div className="rounded-2xl border border-slate-500/30 bg-slate-900/40 p-5 ring-1 ring-slate-500/20">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-300">Expired Codes</p>
            <p className="mt-3 text-3xl font-bold text-slate-100">{stats.expired}</p>
          </div>
        </section>

        <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <div className="flex flex-wrap items-center justify-end gap-2 border-b border-slate-800 px-4 py-3">
            <button
              type="button"
              onClick={toggleAll}
              className="rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-300 hover:bg-slate-800"
            >
              {selected.size === filtered.length && filtered.length > 0 ? 'Unselect all' : 'Select all'}
            </button>
            <button
              type="button"
              disabled={selected.size === 0}
              onClick={deleteSelected}
              className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete selected ({selected.size})
            </button>
            <button
              type="button"
              disabled={codes.length === 0}
              onClick={deleteAll}
              className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200 disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete all
            </button>
          </div>
          {codes.length === 0 ? (
            <div className="px-5 py-14 text-center">
              <p className="text-slate-400">No transfer codes yet.</p>
              <div className="mt-4 flex flex-wrap justify-center gap-3">
                <button
                  type="button"
                  onClick={generateOne}
                  className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-3 text-sm font-bold text-slate-950"
                >
                  Generate Code
                </button>
                <button
                  type="button"
                  onClick={loadCodes}
                  className="rounded-xl border border-slate-600 px-6 py-3 text-sm font-semibold text-slate-300 hover:bg-slate-800"
                >
                  Refresh
                </button>
              </div>
            </div>
          ) : null}
          {codes.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700/80 bg-slate-900/60 text-[11px] uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-semibold">Select</th>
                  <th className="px-4 py-3 font-semibold">Code</th>
                  <th className="px-4 py-3 font-semibold">Device / User</th>
                  <th className="px-4 py-3 font-semibold">Created At</th>
                  <th className="px-4 py-3 font-semibold">Expiry</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((c) => (
                  <tr key={c.id} className="border-b border-slate-800/80 hover:bg-slate-900/50">
                    <td className="px-4 py-3">
                      <input
                        type="checkbox"
                        checked={selected.has(c.id)}
                        onChange={() => toggleOne(c.id)}
                        className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-amber-500 focus:ring-amber-500/40"
                      />
                    </td>
                    <td className="px-4 py-3 font-mono text-base font-bold tracking-wide text-amber-100">
                      {c.code}
                    </td>
                    <td className="max-w-[220px] truncate px-4 py-3 text-slate-300">{c.deviceUser}</td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-400">
                      {formatReadableDateTime(c.createdAt)}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3">
                      <span className="text-slate-400">{formatReadableDateTime(c.expiresAt)}</span>
                      <p className="mt-0.5 font-mono text-xs text-amber-200/90">
                        {c.displayStatus === 'active'
                          ? `⏱ ${formatCountdown(c.expiresAt, nowTick)}`
                          : '—'}
                      </p>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-lg px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ring-1 ${badgeClass(c.displayStatus)}`}
                      >
                        {labelForStatus(c.displayStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => copyCode(c.code)}
                          className="inline-flex items-center gap-1 rounded-lg border border-slate-600 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800"
                        >
                          <Copy className="h-3.5 w-3.5" />
                          Copy
                        </button>
                        {c.displayStatus === 'active' ? (
                          <button
                            type="button"
                            onClick={() => revoke(c.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-1.5 text-xs font-semibold text-amber-100 hover:bg-amber-500/20"
                          >
                            <Ban className="h-3.5 w-3.5" />
                            Revoke
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => deleteOne(c.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-red-500/35 bg-red-500/10 px-3 py-1.5 text-xs font-semibold text-red-200"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          ) : null}
          {codes.length > 0 && filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">No codes match this search.</p>
          ) : null}
        </div>
      </main>
    </>
  )
}

export default TransferCodesPage
