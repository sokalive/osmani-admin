import { useCallback, useEffect, useMemo, useState } from 'react'
import { motion } from 'framer-motion'
import { Pencil, Plus, Trash2 } from 'lucide-react'
import BannerFormModal from '../components/BannerFormModal'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { deleteBanner, getBannersManage, postBanner, putBanner } from '../lib/api'
import {
  canBannerReceiveInteractions,
  isBannerShownInCarousel,
} from '../utils/bannerSchedule'

function normalizeBanner(b) {
  if (!b || typeof b !== 'object') return null
  return {
    ...b,
    createdAt: b.createdAt ? new Date(b.createdAt) : new Date(0),
  }
}

function BannersPage() {
  const { showToast } = useToast()
  const [banners, setBanners] = useState([])
  const [tick, setTick] = useState(0)
  const [isLoading, setIsLoading] = useState(true)
  const [addOpen, setAddOpen] = useState(false)
  const [editingBanner, setEditingBanner] = useState(null)

  const loadBanners = useCallback(async () => {
    try {
      const raw = await getBannersManage()
      const list = Array.isArray(raw) ? raw : []
      setBanners(list.map(normalizeBanner).filter(Boolean))
    } catch (e) {
      showToast('error', e?.message || 'Could not load banners')
      setBanners([])
    } finally {
      setIsLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    loadBanners()
  }, [loadBanners])

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 60_000)
    return () => window.clearInterval(id)
  }, [])

  const sortedBanners = useMemo(() => {
    return [...banners].sort((a, b) => {
      const da = Number(a.sortOrder) || 0
      const db = Number(b.sortOrder) || 0
      if (da !== db) return da - db
      const ta = a.createdAt instanceof Date ? a.createdAt.getTime() : 0
      const tb = b.createdAt instanceof Date ? b.createdAt.getTime() : 0
      return tb - ta
    })
  }, [banners])

  async function handleAddSubmit(payload) {
    try {
      const { id: _id, ...rest } = payload
      await postBanner({
        ...rest,
        createdAt: new Date().toISOString(),
      })
      await loadBanners()
      setAddOpen(false)
      showToast('success', 'Banner created.')
    } catch (e) {
      showToast('error', e?.message || 'Could not create banner')
    }
  }

  async function handleEditSubmit(payload) {
    try {
      const { id, ...rest } = payload
      if (!id) return
      await putBanner(id, {
        ...rest,
        createdAt: editingBanner?.createdAt
          ? editingBanner.createdAt instanceof Date
            ? editingBanner.createdAt.toISOString()
            : editingBanner.createdAt
          : new Date().toISOString(),
      })
      await loadBanners()
      setEditingBanner(null)
      showToast('success', 'Banner updated.')
    } catch (e) {
      showToast('error', e?.message || 'Could not update banner')
    }
  }

  async function handleDelete(id) {
    if (!window.confirm('Delete this banner? This cannot be undone.')) return
    try {
      await deleteBanner(id)
      await loadBanners()
      showToast('success', 'Banner deleted.')
    } catch (e) {
      showToast('error', e?.message || 'Could not delete banner')
    }
  }

  return (
    <>
      <Topbar />

      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400/90">
              Promotions
            </p>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
              Banners
            </h1>
            <p className="mt-1 max-w-xl text-sm text-slate-400">
              Manage hero tiles and routing. Visibility follows enabled, active, and schedule rules
              (preview updates every minute).
            </p>
          </div>
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="inline-flex shrink-0 items-center justify-center gap-2 self-start rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 px-5 py-3 text-xs font-bold uppercase tracking-[0.12em] text-slate-950 shadow-[0_8px_32px_rgba(251,191,36,0.35)] transition-all duration-300 hover:scale-[1.02] hover:brightness-105 active:scale-[0.98]"
          >
            <Plus className="h-4 w-4" strokeWidth={2.5} />
            Add Banner
          </button>
        </header>

        <BannerFormModal
          variant="add"
          isOpen={addOpen}
          banner={null}
          onClose={() => setAddOpen(false)}
          onSubmit={handleAddSubmit}
        />

        <BannerFormModal
          variant="edit"
          isOpen={Boolean(editingBanner)}
          banner={editingBanner}
          onClose={() => setEditingBanner(null)}
          onSubmit={handleEditSubmit}
        />

        {isLoading ? (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div
                key={i}
                className="animate-pulse overflow-hidden rounded-2xl border border-white/10 bg-slate-900/40"
              >
                <div className="aspect-[21/9] bg-slate-800/80" />
                <div className="space-y-3 p-4">
                  <div className="h-5 w-3/4 rounded bg-slate-700/80" />
                  <div className="h-4 w-full rounded bg-slate-800/80" />
                  <div className="h-8 w-24 rounded bg-slate-800/80" />
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
            {sortedBanners.map((b, index) => {
              const now = new Date()
              const shown = isBannerShownInCarousel(b, now)
              const interactive = canBannerReceiveInteractions(b, now)
              void tick

              const activeBorder = b.isActive
                ? 'border-emerald-500/40 shadow-[0_0_32px_rgba(16,185,129,0.2)] ring-2 ring-emerald-400/25'
                : 'border-slate-600/50 shadow-none ring-1 ring-slate-700/60 grayscale-[0.25]'

              return (
                <motion.article
                  key={b.id}
                  layout
                  initial={{ opacity: 0, y: 14 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.28, delay: index * 0.05, ease: [0.16, 1, 0.3, 1] }}
                  className={`group relative flex flex-col overflow-hidden rounded-2xl border bg-slate-950/50 backdrop-blur-sm transition-all duration-300 hover:-translate-y-0.5 ${activeBorder} ${
                    !b.isEnabled ? 'opacity-[0.72]' : ''
                  }`}
                >
                  <div className="relative aspect-[21/9] overflow-hidden bg-slate-800">
                    <img
                      src={b.image}
                      alt=""
                      className={`h-full w-full object-cover transition-transform duration-500 ease-out group-hover:scale-[1.04] ${
                        !b.isEnabled ? 'brightness-[0.85]' : ''
                      }`}
                    />
                    <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/55 to-transparent opacity-70" />
                    {b.badge ? (
                      <span className="absolute left-3 top-3 rounded-md bg-amber-400/95 px-2 py-0.5 text-[10px] font-black uppercase tracking-wider text-slate-950 shadow-lg">
                        {b.badge}
                      </span>
                    ) : null}
                    {!b.isEnabled ? (
                      <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/50">
                        <span className="rounded-full bg-slate-900/90 px-4 py-1.5 text-xs font-bold uppercase tracking-wide text-slate-300 ring-1 ring-slate-500/60">
                          Interactions disabled
                        </span>
                      </div>
                    ) : null}
                  </div>
                  <div className="flex flex-1 flex-col p-4">
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="line-clamp-2 text-lg font-bold leading-snug text-white">
                        {b.title}
                      </h2>
                      <span
                        className={`shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide transition-colors duration-300 ${
                          interactive
                            ? 'bg-emerald-500/25 text-emerald-200 ring-1 ring-emerald-400/40 shadow-[0_0_12px_rgba(16,185,129,0.25)]'
                            : shown && !b.isEnabled
                              ? 'bg-amber-500/20 text-amber-100 ring-1 ring-amber-400/40'
                              : 'bg-slate-700/60 text-slate-400 ring-1 ring-slate-500/50'
                        }`}
                      >
                        {interactive
                          ? 'Live in app'
                          : shown && !b.isEnabled
                            ? 'Shown · taps off'
                            : 'Not shown'}
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-sm text-slate-400">{b.description}</p>

                    <div className="mt-3 flex flex-wrap gap-2 text-[10px] font-semibold uppercase tracking-wide">
                      <span
                        className={`rounded-md px-2 py-0.5 transition-colors duration-300 ${
                          b.isActive
                            ? 'bg-amber-500/20 text-amber-200 ring-1 ring-amber-400/35'
                            : 'bg-slate-700/50 text-slate-400 ring-1 ring-slate-600/60'
                        }`}
                      >
                        {b.isActive ? 'Active' : 'Inactive'}
                      </span>
                      <span
                        className={`rounded-md px-2 py-0.5 ${
                          b.isEnabled
                            ? 'bg-slate-700/40 text-slate-300 ring-1 ring-slate-600/50'
                            : 'bg-red-500/20 text-red-200 ring-1 ring-red-400/35'
                        }`}
                      >
                        {b.isEnabled ? 'Enabled' : 'Disabled'}
                      </span>
                      {b.useTimer ? (
                        <span className="rounded-md bg-violet-500/20 px-2 py-0.5 text-violet-200 ring-1 ring-violet-400/35">
                          Timer {b.startTime}–{b.endTime}
                        </span>
                      ) : (
                        <span className="rounded-md bg-slate-800/80 px-2 py-0.5 text-slate-500 ring-1 ring-slate-700/60">
                          No timer
                        </span>
                      )}
                    </div>

                    {b.redirectChannel ? (
                      <p className="mt-2 truncate text-xs text-amber-200/90">
                        → {b.redirectChannel}
                      </p>
                    ) : null}
                    <p className="mt-1 text-[11px] text-slate-500">
                      Order {b.sortOrder ?? 0}
                      {' · '}
                      {b.createdAt instanceof Date
                        ? b.createdAt.toLocaleDateString(undefined, {
                            year: 'numeric',
                            month: 'short',
                            day: 'numeric',
                          })
                        : ''}
                    </p>

                    <div className="mt-auto flex justify-end gap-1 pt-4">
                      <button
                        type="button"
                        onClick={() => setEditingBanner(b)}
                        className="rounded-xl p-2.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-amber-300"
                        aria-label={`Edit ${b.title}`}
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDelete(b.id)}
                        className="rounded-xl p-2.5 text-slate-400 transition-colors hover:bg-red-500/15 hover:text-red-400"
                        aria-label={`Delete ${b.title}`}
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </div>
                </motion.article>
              )
            })}
          </div>
        )}

        {!isLoading && banners.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-slate-700 py-16 text-center text-sm text-slate-500">
            No banners yet. Click &quot;Add Banner&quot; to create one.
          </p>
        ) : null}
      </main>
    </>
  )
}

export default BannersPage
