import { useCallback, useEffect, useId, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import ToggleSwitch from './ToggleSwitch'
import {
  canBannerReceiveInteractions,
  isBannerShownInCarousel,
  isNowInDailyWindow,
  parseTimeToMinutes,
} from '../utils/bannerSchedule'

const CHANNEL_REDIRECT_OPTIONS = [
  '',
  'Sports Live HD',
  'Africa News 24',
  'Movies Premiere',
  'Kids Zone',
  'Music Hits TV',
  'Documentary Plus',
]

function inputClassName() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25 transition-[border-color,box-shadow] duration-200'
}

function labelClassName() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function emptyForm() {
  return {
    title: '',
    description: '',
    badge: '',
    redirectChannel: '',
    sortOrder: 0,
    isActive: true,
    isEnabled: true,
    useTimer: false,
    startTime: '09:00',
    endTime: '17:00',
  }
}

function bannerToForm(banner) {
  if (!banner) return emptyForm()
  return {
    title: banner.title ?? '',
    description: banner.description ?? '',
    badge: banner.badge ?? '',
    redirectChannel: banner.redirectChannel ?? '',
    sortOrder: Number.isFinite(Number(banner.sortOrder)) ? Number(banner.sortOrder) : 0,
    isActive: banner.isActive !== false,
    isEnabled: banner.isEnabled !== false,
    useTimer: Boolean(banner.useTimer),
    startTime: typeof banner.startTime === 'string' && banner.startTime ? banner.startTime : '09:00',
    endTime: typeof banner.endTime === 'string' && banner.endTime ? banner.endTime : '17:00',
  }
}

/**
 * Shared Add / Edit banner form — matches Channel modal chrome (dark + amber).
 */
function BannerFormModal({ variant, isOpen, banner, onClose, onSubmit }) {
  const formId = useId()
  const [form, setForm] = useState(() => bannerToForm(banner))
  const [imagePreview, setImagePreview] = useState(null)
  /** Base64 or remote URL for API (blob previews are not persistable). */
  const [imageDataUrl, setImageDataUrl] = useState(null)
  const [submitError, setSubmitError] = useState(null)

  useEffect(() => {
    if (!isOpen) return
    setSubmitError(null)
    if (variant === 'edit' && banner) {
      setForm(bannerToForm(banner))
      setImagePreview(banner.image ?? null)
      setImageDataUrl(null)
    }
    if (variant === 'add') {
      setForm(emptyForm())
      setImagePreview(null)
      setImageDataUrl(null)
    }
  }, [isOpen, variant, banner])

  useEffect(() => {
    return () => {
      if (imagePreview?.startsWith('blob:')) {
        URL.revokeObjectURL(imagePreview)
      }
    }
  }, [imagePreview])

  const handleBackdropMouseDown = useCallback(
    (e) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose],
  )

  useEffect(() => {
    if (!isOpen) return
    function onKey(e) {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isOpen, onClose])

  function handleImageChange(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (imagePreview?.startsWith('blob:')) {
      URL.revokeObjectURL(imagePreview)
    }
    setImagePreview(URL.createObjectURL(file))
    const reader = new FileReader()
    reader.onload = () => {
      setImageDataUrl(typeof reader.result === 'string' ? reader.result : null)
    }
    reader.readAsDataURL(file)
  }

  function handleSubmit(e) {
    e.preventDefault()
    setSubmitError(null)

    const title = form.title.trim()
    const description = form.description.trim()
    if (!title) {
      setSubmitError('Title is required.')
      return
    }
    if (!description) {
      setSubmitError('Description is required.')
      return
    }

    const isEdit = variant === 'edit'
    const imageUrl =
      imageDataUrl ||
      (typeof imagePreview === 'string' && !imagePreview.startsWith('blob:') ? imagePreview : '') ||
      (isEdit && banner?.image ? banner.image : '') ||
      ''

    if (!imageUrl) {
      setSubmitError('Please upload a banner image.')
      return
    }

    if (form.useTimer) {
      const s = parseTimeToMinutes(form.startTime)
      const en = parseTimeToMinutes(form.endTime)
      if (s == null || en == null) {
        setSubmitError('Enter valid daily start and end times (HH:mm).')
        return
      }
      if (s === en) {
        setSubmitError('Start and end time must be different.')
        return
      }
    }

    const payload = {
      title,
      description,
      image: imageUrl,
      badge: form.badge.trim(),
      redirectChannel: form.redirectChannel.trim(),
      sortOrder: Number.isFinite(Number(form.sortOrder)) ? Number(form.sortOrder) : 0,
      isActive: form.isActive,
      isEnabled: form.isEnabled,
      useTimer: form.useTimer,
      startTime: form.useTimer ? form.startTime.trim() : '',
      endTime: form.useTimer ? form.endTime.trim() : '',
    }
    if (isEdit && banner?.id) {
      payload.id = banner.id
    }
    onSubmit(payload)
  }

  if (!isOpen) return null

  const isEdit = variant === 'edit'
  const subtitle = isEdit ? 'Edit banner' : 'New banner'
  const titleHeading = isEdit ? form.title || 'Banner' : 'Add Banner'
  const submitLabel = isEdit ? 'Update Banner' : 'Add Banner'

  const activeToggleWrap = form.isActive
    ? 'border-emerald-500/45 bg-emerald-950/25 shadow-[0_0_28px_rgba(16,185,129,0.18)] ring-1 ring-emerald-400/35'
    : 'border-slate-600/60 bg-slate-900/30 ring-1 ring-slate-600/40'

  const previewSlot = {
    isActive: form.isActive,
    useTimer: form.useTimer,
    startTime: form.startTime,
    endTime: form.endTime,
  }
  const slotWouldShow = isBannerShownInCarousel(previewSlot)
  const tapsWouldWork = canBannerReceiveInteractions(
    { ...previewSlot, isEnabled: form.isEnabled },
    new Date(),
  )
  const timerWindowNow = form.useTimer
    ? isNowInDailyWindow(form.startTime, form.endTime, new Date())
    : true

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${formId}-title`}
    >
      <div
        className="absolute inset-0 bg-black/75 backdrop-blur-[2px]"
        aria-hidden
        onMouseDown={handleBackdropMouseDown}
      />

      <div className="relative flex max-h-[min(92vh,960px)] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-slate-600/50 bg-[#0f172a] shadow-[0_24px_80px_rgba(0,0,0,0.55)] ring-1 ring-amber-500/15">
        <header className="flex shrink-0 items-start justify-between gap-4 border-b border-slate-700/70 px-5 py-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400/90">
              {subtitle}
            </p>
            <h2 id={`${formId}-title`} className="mt-1 text-xl font-bold text-white">
              {titleHeading}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-xl p-2 text-slate-400 transition-colors hover:bg-slate-800 hover:text-amber-300"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </header>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="custom-scrollbar flex-1 overflow-y-auto overscroll-contain px-5 py-5">
            <div className="space-y-5">
              <div>
                <label htmlFor={`${formId}-title`} className={labelClassName()}>
                  Title
                </label>
                <input
                  id={`${formId}-title`}
                  type="text"
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  className={inputClassName()}
                  placeholder="Banner title"
                  required
                />
              </div>

              <div>
                <label htmlFor={`${formId}-desc`} className={labelClassName()}>
                  Description
                </label>
                <textarea
                  id={`${formId}-desc`}
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  rows={3}
                  className={`${inputClassName()} min-h-[88px] resize-y`}
                  placeholder="Short description…"
                  required
                />
              </div>

              <div>
                <span className={labelClassName()}>Image</span>
                <div className="flex flex-col gap-3">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleImageChange}
                    className="block w-full text-sm text-slate-400 file:mr-4 file:rounded-lg file:border-0 file:bg-amber-500/20 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-amber-200 hover:file:bg-amber-500/30"
                  />
                  {imagePreview ? (
                    <div className="overflow-hidden rounded-xl border border-slate-600/60 bg-slate-900">
                      <img src={imagePreview} alt="" className="h-40 w-full object-cover" />
                    </div>
                  ) : (
                    <div className="flex h-36 w-full items-center justify-center rounded-xl border border-dashed border-slate-600/70 bg-slate-900/50 text-xs text-slate-500">
                      Upload a banner image
                    </div>
                  )}
                </div>
              </div>

              <div
                className={`rounded-xl border px-3 py-3 transition-all duration-300 ${activeToggleWrap}`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-sm font-medium text-slate-200">Status (visible in app)</span>
                  <div className="flex items-center gap-3">
                    <span
                      className={`text-xs font-bold uppercase tracking-wide transition-colors duration-300 ${form.isActive ? 'text-slate-500' : 'text-slate-300'}`}
                    >
                      Inactive
                    </span>
                    <ToggleSwitch
                      checked={form.isActive}
                      onChange={(next) => setForm((f) => ({ ...f, isActive: next }))}
                      aria-label="Banner active in app"
                    />
                    <span
                      className={`text-xs font-bold uppercase tracking-wide transition-colors duration-300 ${form.isActive ? 'text-amber-200' : 'text-slate-500'}`}
                    >
                      Active
                    </span>
                  </div>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
                  When inactive, the banner is hidden from viewers. Active uses a green / amber
                  highlight.
                </p>
              </div>

              <div className="rounded-xl border border-slate-600/50 bg-slate-900/40 px-3 py-3 transition-all duration-300">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="text-sm font-medium text-slate-300">Enabled</span>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      Off disables taps / navigation for this banner in the app.
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={form.isEnabled}
                    onChange={(next) => setForm((f) => ({ ...f, isEnabled: next }))}
                    aria-label="Banner enabled"
                  />
                </div>
              </div>

              <div>
                <p className={labelClassName()}>Advanced</p>
                <div className="space-y-4 rounded-xl border border-slate-700/60 bg-slate-900/35 p-4">
                  <div>
                    <label htmlFor={`${formId}-badge`} className={labelClassName()}>
                      Badge
                    </label>
                    <input
                      id={`${formId}-badge`}
                      type="text"
                      value={form.badge}
                      onChange={(e) => setForm((f) => ({ ...f, badge: e.target.value }))}
                      className={inputClassName()}
                      placeholder='e.g. "LIVE NOW"'
                    />
                  </div>

                  <div>
                    <label htmlFor={`${formId}-redirect`} className={labelClassName()}>
                      Redirect channel
                    </label>
                    <select
                      id={`${formId}-redirect`}
                      value={form.redirectChannel}
                      onChange={(e) => setForm((f) => ({ ...f, redirectChannel: e.target.value }))}
                      className={inputClassName()}
                    >
                      {CHANNEL_REDIRECT_OPTIONS.map((name) => (
                        <option key={name || 'none'} value={name}>
                          {name || '— None —'}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label htmlFor={`${formId}-sort`} className={labelClassName()}>
                      Sort order
                    </label>
                    <input
                      id={`${formId}-sort`}
                      type="number"
                      min={0}
                      step={1}
                      value={form.sortOrder}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, sortOrder: Number(e.target.value) || 0 }))
                      }
                      className={inputClassName()}
                    />
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-slate-600/50 bg-slate-900/40 px-3 py-3 transition-all duration-300">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <span className="text-sm font-medium text-slate-300">Event timer</span>
                    <p className="mt-0.5 text-[11px] text-slate-500">
                      When on, the banner only appears during the daily window (local time).
                    </p>
                  </div>
                  <ToggleSwitch
                    checked={form.useTimer}
                    onChange={(next) => setForm((f) => ({ ...f, useTimer: next }))}
                    aria-label="Event timer"
                  />
                </div>
              </div>

              <AnimatePresence initial={false}>
                {form.useTimer ? (
                  <motion.div
                    key="timer-fields"
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                    className="overflow-hidden"
                  >
                    <div className="space-y-4 pt-1 pb-2">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <div>
                          <label htmlFor={`${formId}-start`} className={labelClassName()}>
                            Daily start
                          </label>
                          <input
                            id={`${formId}-start`}
                            type="time"
                            value={form.startTime}
                            onChange={(e) => setForm((f) => ({ ...f, startTime: e.target.value }))}
                            className={inputClassName()}
                          />
                        </div>
                        <div>
                          <label htmlFor={`${formId}-end`} className={labelClassName()}>
                            Daily end
                          </label>
                          <input
                            id={`${formId}-end`}
                            type="time"
                            value={form.endTime}
                            onChange={(e) => setForm((f) => ({ ...f, endTime: e.target.value }))}
                            className={inputClassName()}
                          />
                        </div>
                      </div>
                      <p
                        className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors duration-300 ${
                          tapsWouldWork
                            ? 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30'
                            : slotWouldShow && !form.isEnabled
                              ? 'bg-amber-500/15 text-amber-100 ring-1 ring-amber-400/30'
                              : 'bg-slate-800/80 text-slate-400 ring-1 ring-slate-600/50'
                        }`}
                      >
                        {!form.useTimer
                          ? 'Timer off — visibility follows Active only; taps require Enabled.'
                          : !timerWindowNow
                            ? 'Outside today’s daily window — slot hidden while timer is on.'
                            : tapsWouldWork
                              ? 'Inside window — slot visible and taps enabled.'
                              : slotWouldShow && !form.isEnabled
                                ? 'Inside window — slot would show; taps disabled (enable off).'
                                : 'Inside window but inactive — slot hidden.'}
                      </p>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>

              {submitError ? (
                <p className="rounded-lg bg-red-500/15 px-3 py-2 text-sm text-red-200 ring-1 ring-red-400/30">
                  {submitError}
                </p>
              ) : null}
            </div>
          </div>

          <footer className="shrink-0 border-t border-slate-700/70 bg-[#0f172a]/95 px-5 py-4">
            <button
              type="submit"
              className="w-full rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-transform duration-200 hover:scale-[1.01] active:scale-[0.99]"
            >
              {submitLabel}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}

export default BannerFormModal
