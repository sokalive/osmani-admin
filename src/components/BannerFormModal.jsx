import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { X } from 'lucide-react'
import BannerRuntimeOverlayPreview from './BannerRuntimeOverlayPreview'
import ToggleSwitch from './ToggleSwitch'
import { getChannels } from '../lib/api'
import {
  canBannerReceiveInteractions,
  getBannerEventPhase,
  isBannerShownInCarousel,
  isNowInDailyWindow,
  parseTimeToMinutes,
} from '../utils/bannerSchedule'

function isChannelEligible(c) {
  if (!c || typeof c !== 'object') return false
  const active = c.isActive !== false && c.is_active !== false
  const show = c.showInApp !== false && c.show_in_app !== false
  return Boolean(active && show)
}

/** Eligible channels for the picker; include current redirect if it is inactive/hidden so edits stay valid. */
function channelsForRedirectSelect(allList, savedIdRaw) {
  const all = Array.isArray(allList) ? allList : []
  const picked = all.filter(isChannelEligible)
  const sid =
    savedIdRaw === '' || savedIdRaw == null ? null : Number.parseInt(String(savedIdRaw), 10)
  if (sid != null && !Number.isNaN(sid)) {
    const inPicked = picked.some((ch) => Number(ch.id) === sid)
    if (!inPicked) {
      const extra = all.find((ch) => Number(ch.id) === sid)
      if (extra) return [extra, ...picked]
    }
  }
  return picked.slice().sort((a, b) => Number(a.id) - Number(b.id))
}

function inputClassName() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25 transition-[border-color,box-shadow] duration-200'
}

function labelClassName() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function isoToDatetimeLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function datetimeLocalToIso(local) {
  if (!local || !String(local).trim()) return null
  const d = new Date(local)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString()
}

const RUNTIME_OVERLAY_POSITIONS = [
  { value: 'center', label: 'Center' },
  { value: 'bottom_center', label: 'Bottom Center' },
  { value: 'bottom_left', label: 'Bottom Left' },
  { value: 'bottom_right', label: 'Bottom Right' },
  { value: 'top_left', label: 'Top Left' },
  { value: 'top_right', label: 'Top Right' },
]

const DEFAULT_RUNTIME_OVERLAY_POSITION = 'center'

function normalizeRuntimeOverlayPosition(value) {
  const raw = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/-/g, '_')
  const allowed = RUNTIME_OVERLAY_POSITIONS.map((o) => o.value)
  if (!raw || !allowed.includes(raw)) return DEFAULT_RUNTIME_OVERLAY_POSITION
  return raw
}

function emptyForm() {
  return {
    title: '',
    description: '',
    badge: '',
    badgeEnabled: true,
    badgeColor: '#FBBF24',
    badgeBlink: false,
    badgePriority: 0,
    enableCountdown: false,
    eventStartLocal: '',
    eventEndLocal: '',
    redirectChannelId: '',
    sortOrder: 0,
    isActive: true,
    isEnabled: true,
    useTimer: false,
    startTime: '09:00',
    endTime: '17:00',
    runtimePosition: DEFAULT_RUNTIME_OVERLAY_POSITION,
  }
}

function bannerToForm(banner) {
  if (!banner) return emptyForm()
  const es = banner.eventStart ?? banner.event_start
  const ee = banner.eventEnd ?? banner.event_end
  return {
    title: banner.title ?? '',
    description: banner.description ?? '',
    badge: banner.badge ?? '',
    badgeEnabled: banner.badgeEnabled ?? banner.badge_enabled ?? true,
    badgeColor: banner.badgeColor ?? banner.badge_color ?? '#FBBF24',
    badgeBlink: Boolean(banner.badgeBlink ?? banner.badge_blink),
    badgePriority: Number.isFinite(Number(banner.badgePriority ?? banner.badge_priority))
      ? Number(banner.badgePriority ?? banner.badge_priority)
      : 0,
    enableCountdown: Boolean(banner.enableCountdown ?? banner.enable_countdown),
    eventStartLocal: isoToDatetimeLocal(es),
    eventEndLocal: isoToDatetimeLocal(ee),
    redirectChannelId: (() => {
      const rid = banner.redirectChannelId ?? banner.redirect_channel_id
      if (rid == null || rid === '') return ''
      return String(rid)
    })(),
    sortOrder: Number.isFinite(Number(banner.sortOrder)) ? Number(banner.sortOrder) : 0,
    isActive: banner.isActive !== false,
    isEnabled: banner.isEnabled !== false,
    useTimer: Boolean(banner.useTimer ?? banner.eventTimer ?? banner.event_timer),
    startTime: (() => {
      const t =
        banner.startTime ?? banner.dailyStart ?? banner.daily_start ?? ''
      return typeof t === 'string' && t.trim() ? t.trim() : '09:00'
    })(),
    endTime: (() => {
      const t = banner.endTime ?? banner.dailyEnd ?? banner.daily_end ?? ''
      return typeof t === 'string' && t.trim() ? t.trim() : '17:00'
    })(),
    runtimePosition: normalizeRuntimeOverlayPosition(
      banner.runtimePosition ?? banner.runtime_position,
    ),
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
  /** Wall clock for preview / countdown (updated while modal is open). */
  const [clock, setClock] = useState(() => Date.now())
  const [channelsAll, setChannelsAll] = useState([])
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [channelsLoadError, setChannelsLoadError] = useState(null)

  const redirectOptions = useMemo(
    () => channelsForRedirectSelect(channelsAll, form.redirectChannelId),
    [channelsAll, form.redirectChannelId],
  )

  useEffect(() => {
    if (!isOpen) return
    const id = window.setInterval(() => setClock(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (cancelled) return
      setChannelsLoadError(null)
      setChannelsLoading(true)
      getChannels()
        .then((raw) => {
          if (cancelled) return
          setChannelsAll(Array.isArray(raw) ? raw : [])
        })
        .catch((e) => {
          if (cancelled) return
          setChannelsAll([])
          setChannelsLoadError(e?.message || 'Failed to load channels')
        })
        .finally(() => {
          if (!cancelled) setChannelsLoading(false)
        })
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [isOpen])

  useEffect(() => {
    if (!isOpen) return
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (cancelled) return
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
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
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

    if (form.enableCountdown && !form.eventStartLocal?.trim()) {
      setSubmitError('Event start is required when countdown is enabled.')
      return
    }

    const startIso = datetimeLocalToIso(form.eventStartLocal)
    const endIso = datetimeLocalToIso(form.eventEndLocal)
    if (startIso && endIso) {
      if (new Date(endIso).getTime() <= new Date(startIso).getTime()) {
        setSubmitError('Event end must be after event start.')
        return
      }
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

    if (channelsLoading) {
      setSubmitError('Channels are still loading. Try again in a moment.')
      return
    }
    if (channelsLoadError) {
      setSubmitError('Channels could not be loaded. Fix the error below, then retry.')
      return
    }

    const redirectId =
      form.redirectChannelId === '' || form.redirectChannelId == null
        ? null
        : Number.parseInt(String(form.redirectChannelId), 10)
    if (redirectId != null) {
      if (Number.isNaN(redirectId)) {
        setSubmitError('Invalid redirect channel.')
        return
      }
      if (!redirectOptions.some((ch) => Number(ch.id) === redirectId)) {
        setSubmitError('Selected channel does not exist or is no longer available.')
        return
      }
    }

    const payload = {
      title,
      description,
      image: imageUrl,
      badge: form.badge.trim(),
      badgeEnabled: form.badgeEnabled,
      badgeColor: form.badgeColor.trim() || '#FBBF24',
      badgeBlink: form.badgeBlink,
      badgePriority: Number.isFinite(Number(form.badgePriority)) ? Number(form.badgePriority) : 0,
      enableCountdown: form.enableCountdown,
      eventStart: startIso,
      eventEnd: endIso,
      redirectChannelId: redirectId,
      sortOrder: Number.isFinite(Number(form.sortOrder)) ? Number(form.sortOrder) : 0,
      isActive: form.isActive,
      isEnabled: form.isEnabled,
      useTimer: form.useTimer,
      startTime: form.useTimer ? form.startTime.trim() : '',
      endTime: form.useTimer ? form.endTime.trim() : '',
      runtimePosition: normalizeRuntimeOverlayPosition(form.runtimePosition),
      runtime_position: normalizeRuntimeOverlayPosition(form.runtimePosition),
    }
    if (import.meta.env.DEV) {
      console.info('[banner-save] form submit', {
        runtimePosition: payload.runtimePosition,
        runtime_position: payload.runtime_position,
      })
    }
    if (isEdit && banner?.id) {
      payload.id = banner.id
    }
    onSubmit(payload)
  }

  const isEdit = variant === 'edit'
  const eventStartIso = datetimeLocalToIso(form.eventStartLocal)
  const eventEndIso = datetimeLocalToIso(form.eventEndLocal)
  const previewNow = new Date(clock)
  const previewSlot = {
    isActive: form.isActive,
    useTimer: form.useTimer,
    startTime: form.startTime,
    endTime: form.endTime,
    eventStart: eventStartIso,
    eventEnd: eventEndIso,
  }
  const slotWouldShow = isBannerShownInCarousel(previewSlot, previewNow)
  const tapsWouldWork = canBannerReceiveInteractions(
    { ...previewSlot, isEnabled: form.isEnabled },
    previewNow,
  )
  const timerWindowNow = form.useTimer
    ? isNowInDailyWindow(form.startTime, form.endTime, previewNow)
    : true
  const eventPhase = getBannerEventPhase(eventStartIso, eventEndIso, previewNow)

  const previewBadgeVisible = form.badgeEnabled && form.badge.trim().length > 0
  const previewImageSrc =
    imageDataUrl ||
    (typeof imagePreview === 'string' ? imagePreview : null) ||
    (isEdit && banner?.image ? banner.image : null)

  if (!isOpen) return null

  const subtitle = isEdit ? 'Edit banner' : 'New banner'
  const titleHeading = isEdit ? form.title || 'Banner' : 'Add Banner'
  const submitLabel = isEdit ? 'Update Banner' : 'Add Banner'

  const activeToggleWrap = form.isActive
    ? 'border-emerald-500/45 bg-emerald-950/25 shadow-[0_0_28px_rgba(16,185,129,0.18)] ring-1 ring-emerald-400/35'
    : 'border-slate-600/60 bg-slate-900/30 ring-1 ring-slate-600/40'

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
                  placeholder="Short description (optional)"
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

              <div className="rounded-xl border border-slate-600/50 bg-slate-900/40 p-4">
                <p className={labelClassName()}>Preview card</p>
                <div className="relative aspect-[21/9] overflow-hidden rounded-xl border border-slate-600/60 bg-slate-800">
                  {previewImageSrc ? (
                    <img src={previewImageSrc} alt="" className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center text-xs text-slate-500">
                      Add an image to preview
                    </div>
                  )}
                  <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/60 to-transparent" />
                  {previewBadgeVisible ? (
                    <span
                      className={`absolute left-3 top-3 rounded-md px-2 py-0.5 text-[10px] font-black uppercase tracking-wider shadow-lg ${
                        form.badgeBlink ? 'animate-pulse' : ''
                      }`}
                      style={{
                        backgroundColor: form.badgeColor,
                        color: '#0f172a',
                      }}
                    >
                      {form.badge.trim()}
                    </span>
                  ) : null}
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
                      Badge text
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

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-600/50 bg-slate-900/50 px-3 py-2">
                    <span className="text-sm text-slate-300">Badge enabled</span>
                    <ToggleSwitch
                      checked={form.badgeEnabled}
                      onChange={(next) => setForm((f) => ({ ...f, badgeEnabled: next }))}
                      aria-label="Badge enabled"
                    />
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`${formId}-badge-color`} className={labelClassName()}>
                        Badge color
                      </label>
                      <div className="flex gap-2">
                        <input
                          id={`${formId}-badge-color`}
                          type="color"
                          value={/^#[0-9A-Fa-f]{6}$/i.test(form.badgeColor) ? form.badgeColor : '#FBBF24'}
                          onChange={(e) => setForm((f) => ({ ...f, badgeColor: e.target.value }))}
                          className="h-11 w-14 cursor-pointer rounded-lg border border-slate-600 bg-slate-900"
                          aria-label="Badge color"
                        />
                        <input
                          type="text"
                          value={form.badgeColor}
                          onChange={(e) => setForm((f) => ({ ...f, badgeColor: e.target.value }))}
                          className={inputClassName()}
                          placeholder="#FBBF24"
                          maxLength={7}
                        />
                      </div>
                    </div>
                    <div className="flex flex-col justify-end">
                      <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-600/50 bg-slate-900/50 px-3 py-2">
                        <span className="text-sm text-slate-300">Badge blink</span>
                        <ToggleSwitch
                          checked={form.badgeBlink}
                          onChange={(next) => setForm((f) => ({ ...f, badgeBlink: next }))}
                          aria-label="Badge blink"
                        />
                      </div>
                    </div>
                  </div>

                  <div>
                    <label htmlFor={`${formId}-badge-prio`} className={labelClassName()}>
                      Badge priority
                    </label>
                    <input
                      id={`${formId}-badge-prio`}
                      type="number"
                      min={0}
                      step={1}
                      value={form.badgePriority}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, badgePriority: Number(e.target.value) || 0 }))
                      }
                      className={inputClassName()}
                    />
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-600/50 bg-slate-900/50 px-3 py-2">
                    <div>
                      <span className="text-sm text-slate-300">Countdown</span>
                      <p className="mt-0.5 text-[11px] text-slate-500">
                        Show a timer in the app; requires event start when enabled.
                      </p>
                    </div>
                    <ToggleSwitch
                      checked={form.enableCountdown}
                      onChange={(next) => setForm((f) => ({ ...f, enableCountdown: next }))}
                      aria-label="Countdown enabled"
                    />
                  </div>

                  <div>
                    <label htmlFor={`${formId}-runtime-position`} className={labelClassName()}>
                      Runtime overlay position
                    </label>
                    <select
                      id={`${formId}-runtime-position`}
                      value={form.runtimePosition}
                      onChange={(e) => {
                        const next = normalizeRuntimeOverlayPosition(e.target.value)
                        if (import.meta.env.DEV) {
                          console.info('[banner-save] overlay position select', next)
                        }
                        setForm((f) => ({
                          ...f,
                          runtimePosition: next,
                        }))
                      }}
                      className={inputClassName()}
                    >
                      {RUNTIME_OVERLAY_POSITIONS.map((opt) => (
                        <option key={opt.value} value={opt.value}>
                          {opt.label}
                        </option>
                      ))}
                    </select>
                    <p className="mt-1.5 text-[11px] text-slate-500">
                      Where timer/status pills appear on the banner image in the app.
                    </p>
                    <div className="mt-4">
                      <BannerRuntimeOverlayPreview
                        imageSrc={previewImageSrc}
                        runtimePosition={form.runtimePosition}
                        useTimer={form.useTimer}
                        startTime={form.startTime}
                        endTime={form.endTime}
                        enableCountdown={form.enableCountdown}
                        eventStartIso={eventStartIso}
                        eventEndIso={eventEndIso}
                        clock={clock}
                        timerWindowNow={timerWindowNow}
                        eventPhase={eventPhase}
                      />
                    </div>
                  </div>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div>
                      <label htmlFor={`${formId}-ev-start`} className={labelClassName()}>
                        Event start
                      </label>
                      <input
                        id={`${formId}-ev-start`}
                        type="datetime-local"
                        value={form.eventStartLocal}
                        onChange={(e) => setForm((f) => ({ ...f, eventStartLocal: e.target.value }))}
                        className={inputClassName()}
                      />
                    </div>
                    <div>
                      <label htmlFor={`${formId}-ev-end`} className={labelClassName()}>
                        Event end
                      </label>
                      <input
                        id={`${formId}-ev-end`}
                        type="datetime-local"
                        value={form.eventEndLocal}
                        onChange={(e) => setForm((f) => ({ ...f, eventEndLocal: e.target.value }))}
                        className={inputClassName()}
                      />
                    </div>
                  </div>

                  <div>
                    <label htmlFor={`${formId}-redirect`} className={labelClassName()}>
                      Redirect channel
                    </label>
                    <select
                      id={`${formId}-redirect`}
                      value={form.redirectChannelId}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, redirectChannelId: e.target.value }))
                      }
                      className={inputClassName()}
                      disabled={channelsLoading}
                    >
                      <option value="">
                        {channelsLoading ? 'Loading channels…' : '— None —'}
                      </option>
                      {redirectOptions.map((ch) => (
                        <option key={ch.id} value={String(ch.id)}>
                          {ch.name?.trim() ? ch.name : `Channel ${ch.id}`}
                        </option>
                      ))}
                    </select>
                    {channelsLoadError ? (
                      <p className="mt-1.5 text-xs text-red-300">{channelsLoadError}</p>
                    ) : (
                      <p className="mt-1.5 text-[11px] text-slate-500">
                        Only active channels shown in app. Inactive targets on existing banners stay
                        selectable until you clear them.
                      </p>
                    )}
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
                    <p className="mt-1 text-[11px] text-slate-500">
                      You can also reorder banners on the Banners page via drag-and-drop.
                    </p>
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
                        {!timerWindowNow
                          ? 'Outside today’s daily window — app may hide while timer is on.'
                          : eventPhase === 'ended'
                            ? 'Past event_end — hidden from public API.'
                            : eventPhase === 'upcoming'
                              ? 'Pre-start — visible in app (COMING SOON); countdown to event_start.'
                              : tapsWouldWork
                                ? 'Live window — visible; taps enabled.'
                                : slotWouldShow && !form.isEnabled
                                  ? 'Live window — visible; taps disabled (enable off).'
                                  : 'Inactive — hidden from public API.'}
                      </p>
                    </div>
                  </motion.div>
                ) : null}
              </AnimatePresence>
              {!form.useTimer ? (
                <p
                  className={`rounded-lg px-3 py-2 text-xs font-medium transition-colors duration-300 ${
                    tapsWouldWork
                      ? 'bg-emerald-500/15 text-emerald-200 ring-1 ring-emerald-400/30'
                      : slotWouldShow && !form.isEnabled
                        ? 'bg-amber-500/15 text-amber-100 ring-1 ring-amber-400/30'
                        : 'bg-slate-800/80 text-slate-400 ring-1 ring-slate-600/50'
                  }`}
                >
                  {eventPhase === 'ended'
                    ? 'Past event_end — hidden from public API.'
                    : eventPhase === 'upcoming'
                      ? 'Pre-start — visible in app (COMING SOON); no daily timer.'
                      : tapsWouldWork
                        ? 'Live window — visible; taps follow Enabled.'
                        : slotWouldShow && !form.isEnabled
                          ? 'Live window — visible; taps disabled.'
                          : 'Inactive — hidden from public API.'}
                </p>
              ) : null}

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
