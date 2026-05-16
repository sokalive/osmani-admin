import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import {
  adminDatetimeLocalToIso,
  formatAdminDateTime24h,
  formatAdminRemainingFromExpiry,
  isoToAdminDatetimeLocal,
} from '../lib/formatAdminDateTime'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/60 bg-[#0a0e16] px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#f5b301]/50 focus:outline-none focus:ring-2 focus:ring-[#f5b301]/20'
}

function readOnlyInputClass() {
  return `${inputClass()} cursor-not-allowed opacity-90`
}

function labelClass() {
  return 'mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function modalCardClass() {
  return 'rounded-2xl border border-slate-700/50 bg-[#0b0f17] shadow-[0_12px_40px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.04]'
}

function fieldHintClass() {
  return 'mt-1.5 text-xs text-slate-500'
}

export default function SubscriptionEditModal({ row, plans, onClose, onSave }) {
  const [expiresLocal, setExpiresLocal] = useState('')
  const [status, setStatus] = useState('active')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState('')

  useEffect(() => {
    if (!row) return
    setExpiresLocal(isoToAdminDatetimeLocal(row.expires_at))
    setStatus(row.status === 'expired' ? 'expired' : 'active')
    setFormError('')
    setSaving(false)
  }, [row])

  const draftExpiryIso = useMemo(
    () => (expiresLocal ? adminDatetimeLocalToIso(expiresLocal) : null),
    [expiresLocal],
  )

  const draftRemaining = useMemo(
    () => formatAdminRemainingFromExpiry(draftExpiryIso),
    [draftExpiryIso],
  )

  const serverExpiryEat = useMemo(
    () => formatAdminDateTime24h(row?.expires_at, { fallback: '—' }),
    [row?.expires_at],
  )

  const paymentStartedEat = useMemo(
    () => formatAdminDateTime24h(row?.started_at, { fallback: '—' }),
    [row?.started_at],
  )

  const planLabel = useMemo(() => {
    if (!row?.plan_id) return '—'
    const p = (plans || []).find((pl) => Number(pl.id) === Number(row.plan_id))
    return p?.name || `Plan #${row.plan_id}`
  }, [row?.plan_id, plans])

  if (!row) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setFormError('')
    const expiresIso = adminDatetimeLocalToIso(expiresLocal)
    if (!expiresLocal.trim()) {
      setFormError('Expiry date and time are required.')
      return
    }
    if (!expiresIso) {
      setFormError('Invalid expiry — use format YYYY-MM-DD HH:mm (EAT, 24-hour).')
      return
    }
    setSaving(true)
    try {
      await onSave({
        device_id: row.device_id,
        expires_at: expiresIso,
        status,
      })
    } catch {
      setSaving(false)
    }
  }

  function adjustExpiryHours(deltaHours) {
    const baseIso = draftExpiryIso || row.expires_at
    const base = baseIso ? new Date(baseIso) : new Date()
    if (Number.isNaN(base.getTime())) return
    base.setTime(base.getTime() + deltaHours * 3600 * 1000)
    setExpiresLocal(isoToAdminDatetimeLocal(base.toISOString()))
    setFormError('')
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <button
        type="button"
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        aria-label="Close"
        onClick={saving ? undefined : onClose}
      />
      <div
        className={`relative w-full max-w-lg ${modalCardClass()} overflow-hidden`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-subscription-title"
      >
        <div className="border-b border-slate-800/80 bg-[#0a0e16]/80 px-6 py-5">
          <h2 id="edit-subscription-title" className="text-xl font-bold text-white">
            Edit subscription
          </h2>
          <p className="mt-1 font-mono text-xs text-slate-500">{row.device_id}</p>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="max-h-[min(72vh,640px)] overflow-y-auto px-6 py-5">
          <div className="mb-5 rounded-xl border border-[#f5b301]/25 bg-[#f5b301]/[0.06] px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-[#f5c842]/90">
              Current expiry (EAT, 24h)
            </p>
            <p className="mt-1 text-sm font-medium text-white">{serverExpiryEat}</p>
            <p className="mt-2 text-xs text-slate-400">
              Saved remaining:{' '}
              <span className="font-semibold text-slate-200">
                {formatAdminRemainingFromExpiry(row.expires_at)}
              </span>
            </p>
          </div>

          <div className="space-y-4">
            <div>
              <label className={labelClass()}>Phone number</label>
              <input readOnly value={row.phone_number || '—'} className={readOnlyInputClass()} />
              <p className={fieldHintClass()}>From latest transaction on this device</p>
            </div>

            <div>
              <label className={labelClass()} htmlFor="edit-plan">
                Plan
              </label>
              <select
                id="edit-plan"
                value={row.plan_id != null ? String(row.plan_id) : ''}
                disabled
                className={readOnlyInputClass()}
              >
                <option value="">{planLabel}</option>
                {(plans || []).map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.name}
                  </option>
                ))}
              </select>
              <p className={fieldHintClass()}>View only — plan changes require a new payment</p>
            </div>

            <div>
              <label className={labelClass()}>Payment date &amp; time (EAT, 24h)</label>
              <input readOnly value={paymentStartedEat} className={readOnlyInputClass()} />
              <p className={fieldHintClass()}>Subscription started at (stored UTC, shown in EAT)</p>
            </div>

            <div>
              <label className={labelClass()} htmlFor="edit-expiry">
                Expiry date &amp; time (EAT, 24h)
              </label>
              <input
                id="edit-expiry"
                type="datetime-local"
                step={60}
                value={expiresLocal}
                onChange={(e) => {
                  setExpiresLocal(e.target.value)
                  setFormError('')
                }}
                className={inputClass()}
                required
              />
              <p className={fieldHintClass()}>
                Adjust to extend or shorten access. Draft remaining:{' '}
                <span className="font-semibold text-[#f5c842]">{draftRemaining}</span>
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => adjustExpiryHours(-1)}
                  className="rounded-lg border border-slate-600/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800/80"
                >
                  −1 hour
                </button>
                <button
                  type="button"
                  onClick={() => adjustExpiryHours(1)}
                  className="rounded-lg border border-slate-600/80 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-slate-800/80"
                >
                  +1 hour
                </button>
                <button
                  type="button"
                  onClick={() => adjustExpiryHours(24)}
                  className="rounded-lg border border-[#f5b301]/40 bg-[#f5b301]/10 px-3 py-1.5 text-xs font-medium text-[#f5c842] hover:bg-[#f5b301]/20"
                >
                  +24 hours
                </button>
              </div>
            </div>

            <div>
              <label className={labelClass()} htmlFor="edit-status">
                Status
              </label>
              <select
                id="edit-status"
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className={inputClass()}
              >
                <option value="active">Active</option>
                <option value="expired">Expired</option>
              </select>
              <p className={fieldHintClass()}>
                Set to Active when expiry is in the future so clients receive access
              </p>
            </div>
          </div>

          {formError ? (
            <p className="mt-4 text-sm text-red-400" role="alert">
              {formError}
            </p>
          ) : null}

          <div className="mt-6 flex flex-col-reverse gap-2 border-t border-slate-800/80 pt-5 sm:flex-row sm:justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={onClose}
              className="rounded-xl border border-slate-600/80 px-4 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800/80 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-[#f5b301] via-amber-400 to-yellow-500 px-5 py-2.5 text-sm font-bold text-slate-950 shadow-[0_8px_24px_rgba(245,179,1,0.3)] disabled:opacity-50"
            >
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Save changes
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
