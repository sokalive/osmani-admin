import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Pencil, Trash2 } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import ToggleSwitch from '../components/ToggleSwitch'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { deletePlan, getPlans, getUsersLegacy, postPlan, putPlan } from '../lib/api'
import { formatTsh } from '../lib/formatMoney'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'
import { shouldReplaceRows } from '../lib/adminDataGuards'

const EXPIRY_TYPES = [
  { value: 'duration', label: 'Duration-based (payment + days)' },
  { value: 'fixed', label: 'Fixed Time Expiry (daily at HH:MM EAT)' },
]

function emptyDraft() {
  return {
    name: '',
    price: '',
    durationDays: 30,
    expiryType: 'duration',
    fixedExpiryTime: '21:00',
    isActive: true,
  }
}

function planToDraft(plan) {
  return {
    name: plan.name ?? '',
    price: plan.price === 0 || plan.price ? String(plan.price) : '',
    durationDays: plan.durationDays ?? 30,
    expiryType: plan.expiryType === 'fixed' ? 'fixed' : 'duration',
    fixedExpiryTime:
      typeof plan.fixedExpiryTime === 'string' && plan.fixedExpiryTime
        ? plan.fixedExpiryTime.slice(0, 5)
        : '21:00',
    isActive: plan.isActive !== false,
  }
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function validateDraft(form) {
  const e = {}
  if (!form.name?.trim()) e.name = 'Name is required'
  const price = Number(form.price)
  if (form.price === '' || form.price == null) e.price = 'Price is required'
  else if (!Number.isFinite(price) || price < 0) e.price = 'Enter zero or a positive amount'
  const dur = Number(form.durationDays)
  if (!Number.isFinite(dur) || dur < 1) e.durationDays = 'Enter at least 1 day'
  if (form.expiryType === 'fixed') {
    const t = (form.fixedExpiryTime || '').trim()
    if (!/^\d{1,2}:\d{2}$/.test(t)) e.fixedExpiryTime = 'Valid time required (HH:MM EAT)'
  }
  return e
}

function expiryLabel(type) {
  if (type === 'fixed') return 'Fixed Time (EAT)'
  return 'Duration-based'
}

function countActiveSubs(planId, users) {
  const now = Date.now()
  return users.filter(
    (u) =>
      Number(u.plan_id) === Number(planId) &&
      u.status === 'active' &&
      new Date(u.expires_at).getTime() > now,
  ).length
}

const editBtnClass =
  'inline-flex flex-1 items-center justify-center gap-2 rounded-xl border border-slate-600/70 bg-slate-900/60 py-2.5 text-sm font-medium text-slate-200 transition-colors hover:border-amber-500/40 hover:text-amber-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0F1A] active:scale-[0.99]'

function PlansPage() {
  const { showToast } = useToast()
  const cached = readAdminSnapshot('plans')
  const [plans, setPlans] = useState(Array.isArray(cached?.plans) ? cached.plans : [])
  const [users, setUsers] = useState(Array.isArray(cached?.users) ? cached.users : [])
  const plansRef = useRef(Array.isArray(cached?.plans) ? cached.plans : [])
  const usersRef = useRef(Array.isArray(cached?.users) ? cached.users : [])
  plansRef.current = plans
  usersRef.current = users
  const plansGenRef = useRef(0)

  const loadAll = useCallback(async () => {
    const gen = ++plansGenRef.current
    try {
      const [p, u] = await Promise.all([getPlans(), getUsersLegacy()])
      if (gen !== plansGenRef.current) return
      const nextPlans = Array.isArray(p) ? p : []
      const nextUsers = Array.isArray(u) ? u : []
      if (shouldReplaceRows(plansRef.current, nextPlans)) setPlans(nextPlans)
      if (shouldReplaceRows(usersRef.current, nextUsers)) setUsers(nextUsers)
      writeAdminSnapshot('plans', { plans: nextPlans, users: nextUsers })
    } catch (e) {
      if (gen !== plansGenRef.current) return
      showToast('error', e?.message || 'Could not load plans')
    }
  }, [showToast])

  useEffect(() => {
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (!cancelled) void loadAll()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [loadAll])

  const [draft, setDraft] = useState(() => emptyDraft())
  const [editingPlanId, setEditingPlanId] = useState(null)
  const [touched, setTouched] = useState({})
  const [saving, setSaving] = useState(false)
  const [flash, setFlash] = useState(null)

  const errors = useMemo(() => validateDraft(draft), [draft])
  const formValid = Object.keys(errors).length === 0
  const isEditMode = Boolean(editingPlanId)

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4500)
  }

  function cancelEdit() {
    setEditingPlanId(null)
    setDraft(emptyDraft())
    setTouched({})
  }

  function startEdit(plan) {
    setEditingPlanId(plan.id)
    setDraft(planToDraft(plan))
    setTouched({})
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  async function handleSubmit(e) {
    e.preventDefault()
    setTouched({
      name: true,
      price: true,
      durationDays: true,
      fixedExpiryTime: true,
    })
    if (!formValid) {
      showFlash('error', 'Fix the highlighted fields before saving.')
      return
    }
    setSaving(true)
    const common = {
      name: draft.name.trim(),
      price: Number(draft.price),
      durationDays: Math.max(1, Math.floor(Number(draft.durationDays))),
      expiryType: draft.expiryType,
      fixedExpiryTime:
        draft.expiryType === 'fixed' ? draft.fixedExpiryTime.trim().slice(0, 5) : '00:00',
      isActive: draft.isActive,
    }

    try {
      if (editingPlanId) {
        const prev = plans.find((p) => p.id === editingPlanId)
        await putPlan(editingPlanId, {
          ...common,
          createdAt: prev?.createdAt || new Date().toISOString(),
        })
        cancelEdit()
        showFlash('success', 'Plan updated.')
      } else {
        await postPlan(common)
        cancelEdit()
        showFlash('success', 'Plan created and list updated.')
      }
      await loadAll()
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
    setSaving(false)
  }

  async function handleDelete(plan) {
    if (
      !window.confirm(
        `Delete plan "${plan.name}"? Subscribers keep history but this plan will be removed from the catalog.`,
      )
    ) {
      return
    }
    try {
      await deletePlan(plan.id)
      if (editingPlanId === plan.id) {
        cancelEdit()
      }
      await loadAll()
      showFlash('success', 'Plan deleted.')
    } catch (e) {
      showToast('error', e?.message || 'Delete failed')
    }
  }

  return (
    <>
      <Topbar />

      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-8">
        {flash ? (
          <FlashMessage
            type={flash.type}
            message={flash.message}
            onDismiss={() => setFlash(null)}
          />
        ) : null}

        <header>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Subscription Plans
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Manage pricing and plan configurations
          </p>
        </header>

        <section
          className={`rounded-2xl border bg-slate-950/40 p-6 shadow-[0_16px_48px_rgba(0,0,0,0.25)] ring-1 ring-white/[0.04] ${
            isEditMode
              ? 'border-amber-500/40 ring-amber-500/20 shadow-[0_0_40px_rgba(251,191,36,0.08)]'
              : 'border-slate-700/60'
          }`}
        >
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">
                {isEditMode ? 'Edit plan' : 'Create plan'}
              </h2>
              {isEditMode ? (
                <p className="mt-1 inline-flex items-center gap-2 rounded-lg bg-amber-500/15 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-amber-200 ring-1 ring-amber-400/35">
                  Editing Plan…
                </p>
              ) : null}
            </div>
          </div>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div>
                <label className={labelClass()} htmlFor="plan-name">
                  Name
                </label>
                <input
                  id="plan-name"
                  value={draft.name}
                  onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                  onBlur={() => setTouched((t) => ({ ...t, name: true }))}
                  className={inputClass()}
                  placeholder="e.g. Monthly Pro"
                />
                {touched.name && errors.name ? (
                  <p className="mt-1 text-xs text-red-400">{errors.name}</p>
                ) : null}
              </div>
              <div>
                <label className={labelClass()} htmlFor="plan-price">
                  Price (TSh)
                </label>
                <input
                  id="plan-price"
                  type="number"
                  min={0}
                  step={100}
                  value={draft.price}
                  onChange={(e) => setDraft((d) => ({ ...d, price: e.target.value }))}
                  onBlur={() => setTouched((t) => ({ ...t, price: true }))}
                  className={inputClass()}
                />
                {touched.price && errors.price ? (
                  <p className="mt-1 text-xs text-red-400">{errors.price}</p>
                ) : null}
              </div>
              <div>
                <label className={labelClass()} htmlFor="plan-dur">
                  Duration (days)
                </label>
                <input
                  id="plan-dur"
                  type="number"
                  min={1}
                  step={1}
                  value={draft.durationDays}
                  onChange={(e) => setDraft((d) => ({ ...d, durationDays: e.target.value }))}
                  onBlur={() => setTouched((t) => ({ ...t, durationDays: true }))}
                  className={inputClass()}
                />
                {touched.durationDays && errors.durationDays ? (
                  <p className="mt-1 text-xs text-red-400">{errors.durationDays}</p>
                ) : null}
              </div>
              <div>
                <label className={labelClass()} htmlFor="plan-expiry">
                  Expiry type
                </label>
                <select
                  id="plan-expiry"
                  value={draft.expiryType}
                  onChange={(e) => setDraft((d) => ({ ...d, expiryType: e.target.value }))}
                  className={inputClass()}
                >
                  {EXPIRY_TYPES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            <AnimatePresence initial={false}>
              {draft.expiryType === 'fixed' ? (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
                  className="overflow-hidden"
                >
                  <div className="max-w-md pb-2">
                    <label className={labelClass()} htmlFor="plan-time">
                      Daily expiry time (EAT)
                    </label>
                    <input
                      id="plan-time"
                      type="time"
                      value={draft.fixedExpiryTime}
                      onChange={(e) =>
                        setDraft((d) => ({ ...d, fixedExpiryTime: e.target.value }))
                      }
                      onBlur={() => setTouched((t) => ({ ...t, fixedExpiryTime: true }))}
                      className={inputClass()}
                    />
                    {touched.fixedExpiryTime && errors.fixedExpiryTime ? (
                      <p className="mt-1 text-xs text-red-400">{errors.fixedExpiryTime}</p>
                    ) : null}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>

            <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-slate-600/50 bg-slate-900/40 px-4 py-3">
              <span className="text-sm font-medium text-slate-300">Active</span>
              <ToggleSwitch
                checked={draft.isActive}
                onChange={(next) => setDraft((d) => ({ ...d, isActive: next }))}
                aria-label="Plan active"
              />
            </div>

            <div className="flex flex-wrap justify-end gap-3">
              {isEditMode ? (
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="rounded-xl border border-slate-600 px-6 py-3 text-sm font-semibold text-slate-300 transition-colors hover:bg-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0F1A]"
                >
                  Cancel Edit
                </button>
              ) : null}
              <button
                type="submit"
                disabled={!formValid || saving}
                className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-8 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-all duration-300 enabled:hover:scale-[1.02] enabled:hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {saving ? 'Saving…' : isEditMode ? 'Update Plan' : 'Create Plan'}
              </button>
            </div>
          </form>
        </section>

        <section>
          <h2 className="mb-4 text-lg font-semibold text-white">All plans</h2>
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 xl:grid-cols-3">
            {plans.map((p) => {
              const subs =
                p.activeSubscriberCount != null
                  ? Number(p.activeSubscriberCount)
                  : countActiveSubs(p.id, users)
              const isSelected = editingPlanId === p.id
              const activeGlow = p.isActive
                ? 'border-amber-400/35 shadow-[0_0_24px_rgba(251,191,36,0.12)] ring-1 ring-amber-500/20'
                : 'border-slate-700/80 opacity-90 ring-1 ring-slate-700/40'
              const selectedRing = isSelected
                ? 'ring-2 ring-amber-400/70 ring-offset-2 ring-offset-[#0B0F1A]'
                : ''
              return (
                <article
                  key={p.id}
                  className={`flex flex-col rounded-2xl border bg-slate-950/50 p-5 transition-all duration-300 hover:-translate-y-0.5 ${activeGlow} ${selectedRing}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <h3 className="text-lg font-bold text-white">{p.name}</h3>
                    <span
                      className={`shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                        p.isActive
                          ? 'bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-400/40'
                          : 'bg-slate-700/60 text-slate-400 ring-1 ring-slate-600/50'
                      }`}
                    >
                      {p.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  <p className="mt-2 text-2xl font-extrabold text-amber-200">{formatTsh(p.price)}</p>
                  <dl className="mt-4 space-y-2 text-sm text-slate-400">
                    <div className="flex justify-between gap-2">
                      <dt>Duration</dt>
                      <dd className="font-medium text-slate-200">{p.durationDays} days</dd>
                    </div>
                    <div className="flex justify-between gap-2">
                      <dt>Expiry</dt>
                      <dd className="text-right font-medium text-slate-200">
                        {expiryLabel(p.expiryType)}
                        {p.expiryType === 'fixed' ? ` · ${p.fixedExpiryTime}` : ''}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-2 border-t border-slate-800/80 pt-2">
                      <dt>Active subscribers</dt>
                      <dd className="font-bold text-white">{subs}</dd>
                    </div>
                  </dl>
                  <div className="mt-auto flex gap-2 pt-5">
                    <button
                      type="button"
                      onClick={() => startEdit(p)}
                      className={editBtnClass}
                    >
                      <Pencil className="h-4 w-4 shrink-0" aria-hidden />
                      Edit
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(p)}
                      className="inline-flex items-center justify-center rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-400/50 focus-visible:ring-offset-2 focus-visible:ring-offset-[#0B0F1A]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </article>
              )
            })}
          </div>
          {plans.length === 0 ? (
            <p className="mt-6 rounded-xl border border-dashed border-slate-700 py-12 text-center text-slate-500">
              No plans yet — create one above.
            </p>
          ) : null}
        </section>
      </main>
    </>
  )
}

export default PlansPage
