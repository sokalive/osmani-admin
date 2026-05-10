import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { deleteUser, getPlans, getUsers, putUser } from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function remainingLabel(expiresAt) {
  const end = new Date(expiresAt || '')
  if (Number.isNaN(end.getTime())) return 'Expired'
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

function UsersPage() {
  const { showToast } = useToast()
  const [rows, setRows] = useState([])
  const [plans, setPlans] = useState([])
  const [search, setSearch] = useState('')
  const [editing, setEditing] = useState(null)
  const [flash, setFlash] = useState(null)

  const loadAll = useCallback(async () => {
    try {
      const [u, p] = await Promise.all([getUsers(), getPlans()])
      setRows(Array.isArray(u) ? u : [])
      setPlans(Array.isArray(p) ? p : [])
    } catch (e) {
      showToast('error', e?.message || 'Could not load users')
      setRows([])
      setPlans([])
    }
  }, [showToast])

  useEffect(() => {
    loadAll()
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

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} /> : null}
        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Users / Subscriptions</h1>
          <p className="mt-1 text-sm text-slate-400">Device-based subscriptions (EAT display)</p>
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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1040px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700/80 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
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
                {filtered.map((r) => (
                  <tr key={r.device_id} className="border-b border-slate-800/80 transition-colors hover:bg-slate-900/60">
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
                        className="mr-1 inline-flex rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-amber-300"
                        aria-label="Edit"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(r)}
                        className="inline-flex rounded-lg p-2 text-slate-400 hover:bg-red-500/15 hover:text-red-400"
                        aria-label="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {filtered.length === 0 ? <p className="py-12 text-center text-slate-500">No users match this search.</p> : null}
        </div>
        <EditModal row={editing} onClose={() => setEditing(null)} onSave={handleSave} />
      </main>
    </>
  )
}

export default UsersPage
