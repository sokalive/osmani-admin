import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pencil, Trash2 } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { deleteUser, getPlans, getUsers, putUser } from '../lib/api'
import { formatTsh } from '../lib/formatMoney'
import { remainingMs, subscriptionStatus, formatRemaining } from '../lib/subscription'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function UserEditModal({ user, plans, isOpen, onClose, onSave }) {
  const [form, setForm] = useState(null)
  const [errors, setErrors] = useState({})

  useEffect(() => {
    if (isOpen && user) {
      setForm({
        phone: user.phone,
        device: user.device,
        planId: user.planId,
        amount: user.amount,
        startDate: user.startDate.slice(0, 10),
        expiryDate: user.expiryDate.slice(0, 10),
      })
      setErrors({})
    }
  }, [isOpen, user])

  if (!isOpen || !user || !form) return null

  function validate() {
    const e = {}
    if (!form.phone.trim()) e.phone = 'Required'
    if (!form.device.trim()) e.device = 'Required'
    if (plans.length > 0 && !form.planId) e.planId = 'Pick a plan'
    const amt = Number(form.amount)
    if (!Number.isFinite(amt) || amt < 0) e.amount = 'Invalid amount'
    if (!form.startDate) e.startDate = 'Required'
    if (!form.expiryDate) e.expiryDate = 'Required'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  function handleSubmit(ev) {
    ev.preventDefault()
    if (!validate()) return
    const plan = plans.find((p) => p.id === form.planId)
    onSave({
      ...user,
      phone: form.phone.trim(),
      device: form.device.trim(),
      planId: form.planId,
      planName: plan?.name ?? user.planName,
      amount: Number(form.amount),
      startDate: new Date(form.startDate + 'T12:00:00').toISOString(),
      expiryDate: new Date(form.expiryDate + 'T23:59:59').toISOString(),
    })
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={onClose}
      />
      <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-600/50 bg-[#0f172a] p-6 shadow-2xl ring-1 ring-amber-500/15">
        <h2 className="text-xl font-bold text-white">Edit subscription</h2>
        <form onSubmit={handleSubmit} className="mt-4 space-y-4">
          <div>
            <label className={labelClass()}>Phone</label>
            <input
              value={form.phone}
              onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
              className={inputClass()}
            />
            {errors.phone ? <p className="mt-1 text-xs text-red-400">{errors.phone}</p> : null}
          </div>
          <div>
            <label className={labelClass()}>Device</label>
            <input
              value={form.device}
              onChange={(e) => setForm((f) => ({ ...f, device: e.target.value }))}
              className={inputClass()}
            />
            {errors.device ? <p className="mt-1 text-xs text-red-400">{errors.device}</p> : null}
          </div>
          <div>
            <label className={labelClass()}>Plan</label>
            {plans.length === 0 ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-950/40 px-3 py-2 text-sm text-amber-100">
                Create at least one plan under Subscription Plans before assigning users.
              </p>
            ) : (
              <select
                value={form.planId}
                onChange={(e) => {
                  const pid = e.target.value
                  const p = plans.find((x) => x.id === pid)
                  setForm((f) => ({
                    ...f,
                    planId: pid,
                    amount: p ? p.price : f.amount,
                  }))
                }}
                className={inputClass()}
              >
                {plans.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} — {formatTsh(p.price)}
                  </option>
                ))}
              </select>
            )}
            {errors.planId ? <p className="mt-1 text-xs text-red-400">{errors.planId}</p> : null}
          </div>
          <div>
            <label className={labelClass()}>Amount (TSh)</label>
            <input
              type="number"
              min={0}
              step={100}
              value={form.amount}
              onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
              className={inputClass()}
            />
            {errors.amount ? <p className="mt-1 text-xs text-red-400">{errors.amount}</p> : null}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelClass()}>Start</label>
              <input
                type="date"
                value={form.startDate}
                onChange={(e) => setForm((f) => ({ ...f, startDate: e.target.value }))}
                className={inputClass()}
              />
              {errors.startDate ? (
                <p className="mt-1 text-xs text-red-400">{errors.startDate}</p>
              ) : null}
            </div>
            <div>
              <label className={labelClass()}>Expiry</label>
              <input
                type="date"
                value={form.expiryDate}
                onChange={(e) => setForm((f) => ({ ...f, expiryDate: e.target.value }))}
                className={inputClass()}
              />
              {errors.expiryDate ? (
                <p className="mt-1 text-xs text-red-400">{errors.expiryDate}</p>
              ) : null}
            </div>
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
              disabled={plans.length === 0}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-[0_8px_24px_rgba(251,191,36,0.3)] disabled:cursor-not-allowed disabled:opacity-40"
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
  const [users, setUsers] = useState([])
  const [plans, setPlans] = useState([])
  const [search, setSearch] = useState('')
  const [tick, setTick] = useState(0)
  const [editing, setEditing] = useState(null)
  const [flash, setFlash] = useState(null)

  const loadAll = useCallback(async () => {
    try {
      const [u, p] = await Promise.all([getUsers(), getPlans()])
      setUsers(Array.isArray(u) ? u : [])
      setPlans(Array.isArray(p) ? p : [])
    } catch (e) {
      showToast('error', e?.message || 'Could not load users')
      setUsers([])
      setPlans([])
    }
  }, [showToast])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return users
    return users.filter(
      (u) =>
        u.phone.toLowerCase().includes(q) ||
        (u.device && u.device.toLowerCase().includes(q)),
    )
  }, [users, search])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(updated) {
    try {
      await putUser(updated.id, updated)
      await loadAll()
      setEditing(null)
      showFlash('success', 'Subscription updated.')
    } catch (e) {
      showToast('error', e?.message || 'Update failed')
    }
  }

  async function handleDelete(u) {
    if (!window.confirm(`Remove subscription for ${u.phone}?`)) return
    try {
      await deleteUser(u.id)
      await loadAll()
      showFlash('success', 'User subscription removed.')
    } catch (e) {
      showToast('error', e?.message || 'Delete failed')
    }
  }

  const now = new Date()
  void tick

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage
            type={flash.type}
            message={flash.message}
            onDismiss={() => setFlash(null)}
          />
        ) : null}

        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Users / Subscriptions
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Search by phone or device · remaining time updates automatically
          </p>
        </header>

        <div className="max-w-md">
          <label className={labelClass()} htmlFor="user-search">
            Search
          </label>
          <input
            id="user-search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Phone or device…"
            className={inputClass()}
          />
        </div>

        <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-700/80 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
                  <th className="px-4 py-3 font-semibold">Phone</th>
                  <th className="px-4 py-3 font-semibold">Plan</th>
                  <th className="px-4 py-3 font-semibold">Amount</th>
                  <th className="px-4 py-3 font-semibold">Start</th>
                  <th className="px-4 py-3 font-semibold">Expiry</th>
                  <th className="px-4 py-3 font-semibold">Remaining</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => {
                  const ms = remainingMs(u.expiryDate, now)
                  const st = subscriptionStatus(u.expiryDate, now)
                  const remLabel = st === 'expired' ? 'Expired' : formatRemaining(ms)
                  return (
                    <tr
                      key={u.id}
                      className="border-b border-slate-800/80 transition-colors hover:bg-slate-900/60"
                    >
                      <td className="px-4 py-3 font-mono text-slate-200">{u.phone}</td>
                      <td className="px-4 py-3 text-slate-300">{u.planName}</td>
                      <td className="px-4 py-3 text-amber-100/90">{formatTsh(u.amount)}</td>
                      <td className="px-4 py-3 text-slate-400">
                        {new Date(u.startDate).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-slate-400">
                        {new Date(u.expiryDate).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-3 text-slate-300">{remLabel}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-lg px-2.5 py-0.5 text-[11px] font-bold uppercase tracking-wide ring-1 ${
                            st === 'active'
                              ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
                              : 'bg-red-500/20 text-red-200 ring-red-400/40'
                          }`}
                        >
                          {st === 'active' ? 'Active' : 'Expired'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <button
                          type="button"
                          onClick={() => setEditing(u)}
                          className="mr-1 inline-flex rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-amber-300"
                          aria-label="Edit"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(u)}
                          className="inline-flex rounded-lg p-2 text-slate-400 hover:bg-red-500/15 hover:text-red-400"
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
          {filtered.length === 0 ? (
            <p className="py-12 text-center text-slate-500">No users match this search.</p>
          ) : null}
        </div>

        <UserEditModal
          isOpen={Boolean(editing)}
          user={editing}
          plans={plans}
          onClose={() => setEditing(null)}
          onSave={handleSave}
        />
      </main>
    </>
  )
}

export default UsersPage
