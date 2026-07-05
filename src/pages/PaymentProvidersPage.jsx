import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Edit3, Plus, Trash2, Upload } from 'lucide-react'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  deletePaymentProvider,
  getPaymentProvidersSettings,
  postPaymentProviderFormData,
  syncStreamUrl,
  putPaymentProviderFormData,
} from '../lib/api'
import { shouldReplaceRows } from '../lib/adminDataGuards'
import { readAdminSnapshot, writeAdminSnapshot } from '../lib/adminSnapshotCache'

const initialForm = {
  name: '',
  active: true,
}

function toggleClass(active) {
  return [
    'relative inline-flex h-6 w-11 items-center rounded-full transition-colors',
    active ? 'bg-emerald-500' : 'bg-slate-600',
  ].join(' ')
}

function PaymentProvidersPage() {
  const { showToast } = useToast()
  const cached = readAdminSnapshot('payment-providers')
  const initialItems = Array.isArray(cached?.rows) ? cached.rows : []
  const [items, setItems] = useState(initialItems)
  const itemsRef = useRef(initialItems)
  itemsRef.current = items
  const loadGenRef = useRef(0)
  const [loading, setLoading] = useState(initialItems.length === 0)
  const [submitting, setSubmitting] = useState(false)
  const [form, setForm] = useState(initialForm)
  const [logoFile, setLogoFile] = useState(null)
  const [logoPreview, setLogoPreview] = useState('')
  const [editingId, setEditingId] = useState('')

  const load = useCallback(async () => {
    const gen = ++loadGenRef.current
    try {
      const list = await getPaymentProvidersSettings()
      if (gen !== loadGenRef.current) return
      const next = Array.isArray(list) ? list : []
      if (shouldReplaceRows(itemsRef.current, next)) setItems(next)
      writeAdminSnapshot('payment-providers', { rows: next })
    } catch (e) {
      if (gen !== loadGenRef.current) return
      showToast('error', e?.message || 'Could not load payment providers')
    } finally {
      if (gen === loadGenRef.current) setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (!cancelled) void load()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [load])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onRefresh = () => {
      void load()
    }
    es.addEventListener('config.payment_providers_changed', onRefresh)
    return () => es.close()
  }, [load])

  useEffect(() => {
    if (!logoFile) return
    const next = URL.createObjectURL(logoFile)
    setLogoPreview(next)
    return () => URL.revokeObjectURL(next)
  }, [logoFile])

  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const an = String(a?.name || '').toLowerCase()
      const bn = String(b?.name || '').toLowerCase()
      return an.localeCompare(bn)
    })
  }, [items])

  function resetForm() {
    setForm(initialForm)
    setLogoFile(null)
    setLogoPreview('')
    setEditingId('')
  }

  function startEdit(row) {
    setEditingId(String(row?.id || ''))
    setForm({
      name: String(row?.name || ''),
      active: Boolean(row?.active),
    })
    setLogoFile(null)
    setLogoPreview(String(row?.logoUrl || row?.logo || row?.logoPath || ''))
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const name = String(form.name || '').trim()
    if (!name) {
      showToast('error', 'Provider name is required')
      return
    }
    if (!editingId && !logoFile) {
      showToast('error', 'Logo is required for new provider')
      return
    }
    setSubmitting(true)
    try {
      const fd = new FormData()
      fd.append('name', name)
      fd.append('active', String(Boolean(form.active)))
      if (logoFile) fd.append('logo', logoFile)

      if (editingId) {
        await putPaymentProviderFormData(editingId, fd)
        showToast('success', 'Provider updated')
      } else {
        await postPaymentProviderFormData(fd)
        showToast('success', 'Provider added')
      }
      resetForm()
      await load()
    } catch (e2) {
      showToast('error', e2?.message || 'Could not save provider')
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this payment provider?')) return
    try {
      await deletePaymentProvider(id)
      if (editingId && editingId === String(id)) resetForm()
      await load()
      showToast('success', 'Provider deleted')
    } catch (e) {
      showToast('error', e?.message || 'Could not delete provider')
    }
  }

  return (
    <>
      <Topbar />

      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <header className="flex flex-col gap-2">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400/90">
            Payments
          </p>
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Payment Providers
          </h1>
          <p className="text-sm text-slate-400">
            Manage payment networks with logo uploads and active states.
          </p>
        </header>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-amber-400/90">
            {editingId ? 'Edit Provider' : 'Add Provider'}
          </h2>
          <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Provider Name
              </label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. M-Pesa"
                className="w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Upload Logo (PNG/JPG/WebP)
              </label>
              <label className="flex cursor-pointer items-center justify-center gap-2 rounded-xl border border-dashed border-slate-600/80 bg-slate-900/70 px-3 py-2.5 text-sm text-slate-300 hover:border-amber-400/70 hover:text-amber-200">
                <Upload className="h-4 w-4" />
                <span>{logoFile ? logoFile.name : 'Choose logo file'}</span>
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/jpg,image/webp"
                  className="hidden"
                  onChange={(e) => setLogoFile(e.target.files?.[0] || null)}
                />
              </label>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Active
              </label>
              <button
                type="button"
                onClick={() => setForm((f) => ({ ...f, active: !f.active }))}
                className={toggleClass(Boolean(form.active))}
                aria-label="Toggle active"
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-white transition ${
                    form.active ? 'translate-x-6' : 'translate-x-1'
                  }`}
                />
              </button>
            </div>

            <div className="lg:col-span-3">
              <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
                Logo Preview
              </label>
              <div className="flex h-28 w-full items-center justify-center overflow-hidden rounded-xl border border-slate-700/70 bg-slate-900/50">
                {logoPreview ? (
                  <img
                    src={logoPreview}
                    alt="Provider logo preview"
                    className="h-full w-full object-contain p-2"
                  />
                ) : (
                  <p className="text-xs text-slate-500">No logo selected</p>
                )}
              </div>
            </div>

            <div className="lg:col-span-3 flex justify-end gap-3">
              {editingId ? (
                <button
                  type="button"
                  onClick={resetForm}
                  className="rounded-xl border border-slate-600 px-6 py-2.5 text-sm font-medium text-slate-300 hover:bg-slate-800"
                >
                  Cancel Edit
                </button>
              ) : null}
              <button
                type="submit"
                disabled={submitting}
                className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-2.5 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:opacity-50"
              >
                <Plus className="h-4 w-4" />
                {editingId ? 'Update Provider' : 'Add Provider'}
              </button>
            </div>
          </form>
        </section>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-amber-400/90">
            Providers
          </h2>
          {loading ? (
            <p className="text-sm text-slate-500">Loading providers...</p>
          ) : sorted.length === 0 ? (
            <p className="text-sm text-slate-500">No payment providers yet.</p>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {sorted.map((row) => (
                <article
                  key={row.id}
                  className="rounded-xl border border-slate-700/70 bg-slate-900/60 p-4"
                >
                  <div className="mb-3 flex h-24 w-full items-center justify-center overflow-hidden rounded-lg border border-slate-700 bg-slate-950/60">
                    {row.logoUrl ? (
                      <img
                        src={row.logoUrl}
                        alt={row.name}
                        className="h-full w-full object-contain p-2"
                      />
                    ) : (
                      <span className="text-xs text-slate-500">No logo</span>
                    )}
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="text-base font-semibold text-white">{row.name}</h3>
                      <p
                        className={`mt-1 inline-flex rounded-md px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${
                          row.active
                            ? 'bg-emerald-500/20 text-emerald-200 ring-1 ring-emerald-400/35'
                            : 'bg-slate-700/60 text-slate-400 ring-1 ring-slate-600/60'
                        }`}
                      >
                        {row.active ? 'Active' : 'Inactive'}
                      </p>
                    </div>
                    <div className="flex gap-1">
                      <button
                        type="button"
                        onClick={() => startEdit(row)}
                        className="rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-amber-300"
                        aria-label={`Edit ${row.name}`}
                      >
                        <Edit3 className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(row.id)}
                        className="rounded-lg p-2 text-slate-400 hover:bg-red-500/15 hover:text-red-400"
                        aria-label={`Delete ${row.name}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </article>
              ))}
            </div>
          )}
        </section>
      </main>
    </>
  )
}

export default PaymentProvidersPage
