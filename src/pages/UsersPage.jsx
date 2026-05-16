import { useCallback, useEffect, useMemo, useState, Component } from 'react'
import { Loader2, Pencil, Trash2 } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { deleteUser, deleteUsersBulk, getPlans, getUsers, putUser, syncStreamUrl } from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function remainingLabel(expiresAt) {
  if (expiresAt == null || expiresAt === '') return '—'
  const end = new Date(expiresAt)
  if (Number.isNaN(end.getTime())) return '—'
  const ms = end.getTime() - Date.now()
  if (ms <= 0) return 'Expired'
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
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

function EditModal({ row, onClose, onSave }) {
  const [expiresAt, setExpiresAt] = useState('')
  const [status, setStatus] = useState('active')

  useEffect(() => {
    if (!row) return
    setExpiresAt(row.expires_at ? String(row.expires_at).slice(0, 16) : '')
    setStatus(row.status === 'expired' ? 'expired' : 'active')
  }, [row])

  if (!row) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-600/50 bg-[#0f172a] p-6 shadow-2xl ring-1 ring-amber-500/15">
        <h2 className="text-xl font-bold text-white">Edit subscription</h2>
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault()
            onSave({
              device_id: row.device_id,
              expires_at: expiresAt ? new Date(expiresAt).toISOString() : null,
              status,
            })
          }}
        >
          <div>
            <label className={labelClass()}>Device ID</label>
            <input value={row.device_id} disabled className={`${inputClass()} opacity-70`} />
          </div>
          <div>
            <label className={labelClass()}>Expiry (ISO)</label>
            <input
              type="datetime-local"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              className={inputClass()}
            />
          </div>
          <div>
            <label className={labelClass()}>Status</label>
            <select value={status} onChange={(e) => setStatus(e.target.value)} className={inputClass()}>
              <option value="active">active</option>
              <option value="expired">expired</option>
            </select>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-xl border border-slate-600 px-4 py-2.5 text-sm text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-[0_8px_24px_rgba(251,191,36,0.3)]"
            >
              Save
            </button>
          </div>
        </form>
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
              <p className="mt-3 text-xs text-slate-400">
                Check the browser console for <code className="text-slate-300">[UsersPage]</code> details.
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

function UsersPageContent() {
  const { showToast } = useToast()
  const [rows, setRows] = useState([])
  const [plans, setPlans] = useState([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [flash, setFlash] = useState(null)
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(() => new Set())
  const [bulkDeleting, setBulkDeleting] = useState(false)
  const [confirm, setConfirm] = useState(null)

  const loadAll = useCallback(async () => {
    try {
      const [u, p] = await Promise.all([getUsers(), getPlans()])
      setRows(Array.isArray(u) ? u : [])
      setPlans(Array.isArray(p) ? p : [])
    } catch (e) {
      showToast('error', e?.message || 'Could not load users')
      setRows([])
      setPlans([])
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['analytics']))
    const onRefresh = () => {
      void loadAll()
    }
    es.addEventListener('analytics.subscription_updated', onRefresh)
    es.addEventListener('analytics.transaction_updated', onRefresh)
    return () => es.close()
  }, [loadAll])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  const planMap = useMemo(() => {
    const m = new Map()
    plans.forEach((p) => m.set(Number(p.id), p.name))
    return m
  }, [plans])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return rows
    return rows.filter(
      (r) =>
        String(r.device_id || '')
          .toLowerCase()
          .includes(q) ||
        String(r.phone_number || '')
          .toLowerCase()
          .includes(q),
    )
  }, [rows, search])

  const visibleIds = useMemo(() => filtered.map((r) => String(r.device_id)), [filtered])
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
      await loadAll()
      showFlash('success', 'Subscription updated.')
    } catch (e) {
      showToast('error', e?.message || 'Update failed')
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
      await loadAll()
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
          await loadAll()
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
      await loadAll()
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

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} /> : null}
        <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Users / Subscriptions</h1>
            <p className="mt-1 text-sm text-slate-400">
              Device-based subscriptions (EAT display)
              {filtered.length !== rows.length ? (
                <span className="ml-2 text-amber-300/90">
                  · showing {filtered.length} of {rows.length}
                </span>
              ) : (
                <span className="ml-2 text-slate-500">· {rows.length} total</span>
              )}
            </p>
          </div>
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
            <button
              type="button"
              disabled={filtered.length === 0 || bulkDeleting}
              onClick={() =>
                setConfirm({
                  kind: 'all',
                  count: filtered.length,
                  ids: visibleIds,
                })
              }
              className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/35 bg-red-950/40 px-4 py-2.5 text-sm font-semibold text-red-200 hover:bg-red-500/15 disabled:opacity-40"
            >
              Delete all visible
            </button>
          </div>
        </header>

        <div className="max-w-md">
          <label className={labelClass()} htmlFor="user-search">
            Search
          </label>
          <input
            id="user-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Device ID or phone…"
            className={inputClass()}
          />
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-slate-400">
              <Loader2 className="h-5 w-5 animate-spin text-amber-400" />
              Loading users…
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/80 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
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
                    <th className="px-4 py-3 font-semibold">Device ID</th>
                    <th className="px-4 py-3 font-semibold">Phone</th>
                    <th className="px-4 py-3 font-semibold">Plan</th>
                    <th className="px-4 py-3 font-semibold">Started (EAT)</th>
                    <th className="px-4 py-3 font-semibold">Expiry (EAT)</th>
                    <th className="px-4 py-3 font-semibold">Remaining</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((r) => {
                    const id = String(r.device_id)
                    const checked = selected.has(id)
                    return (
                      <tr
                        key={id}
                        className={`border-b border-slate-800/80 transition-colors hover:bg-slate-900/60 ${
                          checked ? 'bg-amber-500/[0.06]' : ''
                        }`}
                      >
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
                        <td className="px-4 py-3 font-mono text-xs text-slate-200">{r.device_id}</td>
                        <td className="px-4 py-3 font-mono text-slate-200">{r.phone_number || '-'}</td>
                        <td className="px-4 py-3 text-slate-300">
                          {r.plan_id != null ? planMap.get(Number(r.plan_id)) || `Plan #${r.plan_id}` : '-'}
                        </td>
                        <td className="px-4 py-3 text-slate-400">
                          {formatAdminDateTime(r.started_at, { fallback: '-' })}
                        </td>
                        <td className="px-4 py-3 text-slate-400">
                          {formatAdminDateTime(r.expires_at, { fallback: '-' })}
                        </td>
                        <td className="px-4 py-3 text-slate-300">{remainingLabel(r.expires_at)}</td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex rounded-lg px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${
                              r.status === 'active'
                                ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
                                : 'bg-red-500/20 text-red-200 ring-red-400/40'
                            }`}
                          >
                            {String(r.status || 'expired').toUpperCase()}
                          </span>
                        </td>
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
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
          {!loading && filtered.length === 0 ? (
            <p className="py-12 text-center text-slate-500">
              {rows.length === 0 ? 'No subscriptions yet.' : 'No users match this search.'}
            </p>
          ) : null}
        </div>

        <EditModal row={editing} onClose={() => setEditing(null)} onSave={handleSave} />

        <ConfirmModal
          open={confirm?.kind === 'selected'}
          title="Delete selected users?"
          message={`Remove ${confirm?.count ?? 0} selected subscription(s) and their transactions? Active subscriptions will be removed.`}
          confirmLabel="Delete selected"
          loading={bulkDeleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() =>
            runBulkDelete(confirm?.ids ?? [], { label: 'Delete selected' })
          }
        />

        <ConfirmModal
          open={confirm?.kind === 'all'}
          title="Delete all users?"
          message="Are you sure you want to delete all users/subscriptions shown in this table? This cannot be undone."
          confirmLabel="Delete all"
          loading={bulkDeleting}
          onCancel={() => setConfirm(null)}
          onConfirm={() => runBulkDelete(confirm?.ids ?? [], { label: 'Delete all' })}
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
