import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, MousePointerClick, X } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  API_ORIGIN,
  deleteAllNotifications,
  deleteNotification,
  getChannels,
  getNotifications,
  getOnesignalDiagnostics,
  postNotification,
  prepareNotificationImage,
  putNotification,
  syncNotificationStats,
  syncStreamUrl,
} from '../lib/api'
import {
  ADMIN_DISPLAY_TIMEZONE,
  adminDateAndTimeToIso,
  adminDateFromIso,
  adminTimeFromIso,
  formatAdminDateTime,
} from '../lib/formatAdminDateTime'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function statNum(value) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  return Number(value).toLocaleString()
}

function statPct(value) {
  if (value == null || Number.isNaN(Number(value))) return '—'
  return `${Number(value).toFixed(1)}%`
}

/** OneSignal metric cell: number, pending, N/A, or explicit unavailable status. */
function analyticsMetric(n, field, { pct = false } = {}) {
  const raw = n?.[field]
  if (raw != null && raw !== '' && !Number.isNaN(Number(raw))) {
    return pct ? statPct(raw) : statNum(raw)
  }
  if (n?.kind === 'system') return 'N/A'
  if (n?.status === 'scheduled') return '—'
  if (n?.status === 'cancelled') return '—'
  if (n?.onesignalStatsError) return 'Unavailable'
  if (n?.status === 'sent' && n?.onesignalId && !n?.onesignalStatsSyncedAt) return 'Pending'
  if (n?.status === 'sent' && n?.kind === 'admin' && !n?.onesignalId) return 'No push ID'
  if (n?.status === 'sent' && n?.onesignalStatsSyncedAt) return pct ? '0.0%' : '0'
  return '—'
}

function analyticsMetricTitle(n) {
  if (n?.onesignalStatsError) return n.onesignalStatsError
  if (n?.status === 'scheduled' && n?.scheduleAt) {
    return `Scheduled for ${formatAdminDateTime(n.scheduleAt)} (${ADMIN_DISPLAY_TIMEZONE})`
  }
  if (n?.status === 'sent' && n?.onesignalId && !n?.onesignalStatsSyncedAt) {
    return 'Waiting for first OneSignal analytics sync'
  }
  return undefined
}

function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(Number(bytes))) return '—'
  const n = Number(bytes)
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

const RECURRENCE_OPTIONS = [
  { value: 'once', label: 'Once' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'interval_minutes', label: 'Every X minutes' },
  { value: 'interval_hours', label: 'Every X hours' },
]

function destinationSummary(n) {
  const d = n?.destination
  if (d?.type === 'channel') {
    return d.channelName ? `Channel: ${d.channelName}` : `Channel #${d.channelId ?? '?'}`
  }
  if (d?.type === 'custom') return `Custom: ${d.deepLink || n?.targetType || '—'}`
  return 'Home'
}

function notificationPreviewUrl(pathOrUrl) {
  const raw = String(pathOrUrl || '').trim()
  if (!raw) return ''
  if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('blob:') || raw.startsWith('data:'))
    return raw
  return `${API_ORIGIN}${raw.startsWith('/') ? raw : `/${raw}`}`
}

function StatBadge({ label, value, tone = 'slate', title }) {
  const tones = {
    emerald: 'border-emerald-500/35 bg-emerald-500/15 text-emerald-100',
    sky: 'border-sky-500/35 bg-sky-500/15 text-sky-100',
    red: 'border-red-500/35 bg-red-500/15 text-red-100',
    amber: 'border-amber-500/35 bg-amber-500/15 text-amber-100',
    slate: 'border-slate-600/50 bg-slate-800/60 text-slate-200',
  }
  return (
    <span
      title={title}
      className={`inline-flex min-w-[4.5rem] flex-col rounded-lg border px-2 py-1 text-center ring-1 ring-white/[0.03] ${tones[tone] || tones.slate}`}
    >
      <span className="text-[9px] font-bold uppercase tracking-wide opacity-80">{label}</span>
      <span className="text-sm font-bold tabular-nums">{value}</span>
    </span>
  )
}

function NotificationsPage() {
  const { showToast } = useToast()
  const [notifications, setNotifications] = useState([])

  const loadNotifications = useCallback(async () => {
    try {
      const list = await getNotifications()
      setNotifications(Array.isArray(list) ? list : [])
      return true
    } catch (e) {
      showToast('error', e?.message || 'Could not load notifications')
      return false
    }
  }, [showToast])

  useEffect(() => {
    loadNotifications()
  }, [loadNotifications])

  useEffect(() => {
    const id = window.setInterval(() => {
      loadNotifications()
    }, 15_000)
    return () => window.clearInterval(id)
  }, [loadNotifications])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onChanged = () => {
      void loadNotifications()
    }
    es.addEventListener('config.notifications_changed', onChanged)
    return () => es.close()
  }, [loadNotifications])

  const [title, setTitle] = useState('')
  const [message, setMessage] = useState('')
  const [imagePreview, setImagePreview] = useState(null)
  const [imageData, setImageData] = useState('')
  const [imageUpload, setImageUpload] = useState(null)
  const [imagePreparing, setImagePreparing] = useState(false)
  const [destinationType, setDestinationType] = useState('home')
  const [selectedChannelId, setSelectedChannelId] = useState('')
  const [customDeepLink, setCustomDeepLink] = useState('osmani://settings')
  const [channels, setChannels] = useState([])
  const [channelsLoading, setChannelsLoading] = useState(false)
  const [recurrenceKind, setRecurrenceKind] = useState('once')
  const [recurrenceInterval, setRecurrenceInterval] = useState('30')
  const [recurrenceUntilDate, setRecurrenceUntilDate] = useState('')
  const [recurrenceUntilTime, setRecurrenceUntilTime] = useState('')
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [instant, setInstant] = useState(true)
  const [touched, setTouched] = useState(false)
  const [sending, setSending] = useState(false)
  const [deletingAll, setDeletingAll] = useState(false)
  const [deletingId, setDeletingId] = useState(null)
  const [diag, setDiag] = useState(null)
  const [diagBusy, setDiagBusy] = useState(false)
  const [flash, setFlash] = useState(null)
  const [detailRow, setDetailRow] = useState(null)
  const [refreshingStatsId, setRefreshingStatsId] = useState(null)
  const [scheduleActionId, setScheduleActionId] = useState(null)
  const [rescheduleRow, setRescheduleRow] = useState(null)
  const [rescheduleDate, setRescheduleDate] = useState('')
  const [rescheduleTime, setRescheduleTime] = useState('')

  const showFlash = useCallback((type, msg) => {
    setFlash({ type, message: msg })
    window.setTimeout(() => setFlash(null), 4500)
  }, [])

  useEffect(() => {
    let cancelled = false
    setChannelsLoading(true)
    getChannels()
      .then((list) => {
        if (!cancelled) setChannels(Array.isArray(list) ? list : [])
      })
      .catch(() => {
        if (!cancelled) setChannels([])
      })
      .finally(() => {
        if (!cancelled) setChannelsLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (instant) setRecurrenceKind('once')
  }, [instant])

  const selectedChannel = useMemo(
    () => channels.find((c) => String(c.id) === String(selectedChannelId)),
    [channels, selectedChannelId],
  )

  const buildDestinationPayload = useCallback(() => {
    const base = { type: destinationType }
    if (destinationType === 'channel') {
      return {
        ...base,
        channelId: Number(selectedChannelId),
        channelName: selectedChannel?.name || '',
      }
    }
    if (destinationType === 'custom') {
      return { ...base, customDeepLink: customDeepLink.trim() }
    }
    return base
  }, [destinationType, selectedChannelId, selectedChannel, customDeepLink])

  const stats = useMemo(() => {
    const sentRows = notifications.filter((n) => n.status === 'sent')
    const scheduledRows = notifications.filter((n) => n.status === 'scheduled')
    const sent = sentRows.length
    const scheduled = scheduledRows.length
    const delivered = sentRows.reduce((s, n) => s + (Number(n.onesignalDelivered) || 0), 0)
    const clicked = sentRows.reduce((s, n) => s + (Number(n.onesignalClicked) || 0), 0)
    const failed = sentRows.reduce((s, n) => s + (Number(n.onesignalFailed) || 0), 0)
    const ctr = delivered > 0 ? Math.round((clicked / delivered) * 1000) / 10 : null
    return { sent, scheduled, delivered, clicked, failed, ctr }
  }, [notifications])

  useEffect(() => {
    return () => {
      if (imagePreview?.startsWith('blob:')) URL.revokeObjectURL(imagePreview)
    }
  }, [imagePreview])

  const errors = useMemo(() => {
    const e = {}
    if (!title.trim()) e.title = 'Title is required'
    if (!message.trim()) e.message = 'Message is required'
    if (destinationType === 'channel' && !selectedChannelId) e.channel = 'Select a channel'
    if (destinationType === 'custom' && !customDeepLink.trim()) e.customDeepLink = 'Enter a deep link'
    if (!instant) {
      if (!scheduleDate) e.schedule = 'Pick a date'
      else if (!scheduleTime) e.schedule = 'Pick a time'
      else {
        const iso = adminDateAndTimeToIso(scheduleDate, scheduleTime)
        if (!iso) e.schedule = 'Invalid schedule (use EAT date and time)'
        else if (new Date(iso).getTime() <= Date.now()) e.schedule = 'Schedule must be in the future (EAT)'
      }
      if (
        (recurrenceKind === 'interval_minutes' || recurrenceKind === 'interval_hours') &&
        (!recurrenceInterval || Number(recurrenceInterval) < 1)
      ) {
        e.recurrenceInterval = 'Interval must be at least 1'
      }
    }
    return e
  }, [
    title,
    message,
    destinationType,
    selectedChannelId,
    customDeepLink,
    instant,
    scheduleDate,
    scheduleTime,
    recurrenceKind,
    recurrenceInterval,
  ])

  const valid = Object.keys(errors).length === 0

  async function handleImage(e) {
    const file = e.target.files?.[0]
    if (!file) return
    const mime = String(file.type || '').toLowerCase()
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp']
    if (!allowed.includes(mime) && !/\.(jpe?g|png|webp)$/i.test(file.name || '')) {
      showFlash('error', 'Use JPG, JPEG, PNG or WEBP.')
      e.target.value = ''
      return
    }
    if (imagePreview?.startsWith('blob:')) URL.revokeObjectURL(imagePreview)
    setImagePreparing(true)
    setImageUpload(null)
    setImageData('')
    setImagePreview(null)
    try {
      const out = await prepareNotificationImage(file)
      if (!out?.ok) throw new Error(out?.error || 'Image upload failed')
      const stored = out.imageForDb || out.image || ''
      setImageData(stored)
      setImagePreview(out.previewUrl || notificationPreviewUrl(stored))
      setImageUpload({
        originalBytes: out.originalBytes ?? file.size,
        compressedBytes: out.compressedBytes,
        width: out.width,
        height: out.height,
        format: out.format,
        savedPercent: out.savedPercent,
        pushReady: out.pushReady === true,
        message: out.message || 'Image optimized and saved',
      })
      showFlash('success', out.message || 'Image ready for push.')
    } catch (err) {
      setImageData('')
      setImagePreview(null)
      setImageUpload({ error: err?.message || 'Upload failed' })
      showFlash('error', err?.message || 'Image upload failed')
      e.target.value = ''
    } finally {
      setImagePreparing(false)
    }
  }

  async function handleSend(e) {
    e.preventDefault()
    setTouched(true)
    if (!valid) {
      showFlash('error', 'Fix validation errors before sending.')
      return
    }
    setSending(true)
    try {
      const iso = instant ? null : adminDateAndTimeToIso(scheduleDate, scheduleTime)
      const recurrenceUntil =
        !instant && recurrenceUntilDate && recurrenceUntilTime
          ? adminDateAndTimeToIso(recurrenceUntilDate, recurrenceUntilTime)
          : null
      const created = await postNotification({
        title: title.trim(),
        message: message.trim(),
        image: imageData || '',
        targetAudience: 'all',
        destination: buildDestinationPayload(),
        scheduleAt: instant ? null : iso,
        recurrenceAnchorAt: instant ? null : iso,
        status: instant ? 'sent' : 'scheduled',
        sentAt: instant ? new Date().toISOString() : null,
        recurrenceKind: instant ? 'once' : recurrenceKind,
        recurrenceInterval:
          recurrenceKind === 'interval_minutes' || recurrenceKind === 'interval_hours'
            ? Number(recurrenceInterval) || 1
            : null,
        recurrenceUntil,
        clicks: 0,
      })
      if (created?.id) {
        setNotifications((prev) => [
          created,
          ...prev.filter((row) => row.id !== created.id),
        ])
      }
      await loadNotifications()
      if (instant) {
        const r = created?.onesignalRecipients
        const id = created?.onesignalId
        showFlash(
          'success',
          typeof r === 'number'
            ? `Push sent to all users (${r} recipients${id ? `, OneSignal ${id.slice(0, 8)}…` : ''}).`
            : 'Push sent to all users via OneSignal.',
        )
      } else {
        const recurLabel =
          RECURRENCE_OPTIONS.find((o) => o.value === recurrenceKind)?.label || recurrenceKind
        showFlash(
          'success',
          recurrenceKind === 'once'
            ? `Scheduled for ${formatAdminDateTime(iso)} (EAT). The server will send the push at that time.`
            : `${recurLabel} schedule starting ${formatAdminDateTime(iso)} (EAT).`,
        )
      }
      setTitle('')
      setMessage('')
      setImageData('')
      setImagePreview(null)
      setImageUpload(null)
      setDestinationType('home')
      setSelectedChannelId('')
      setCustomDeepLink('osmani://settings')
      setRecurrenceKind('once')
      setRecurrenceInterval('30')
      setRecurrenceUntilDate('')
      setRecurrenceUntilTime('')
      setScheduleDate('')
      setScheduleTime('')
      setInstant(true)
      setTouched(false)
    } catch (err) {
      showToast('error', err?.message || 'Send failed')
    }
    setSending(false)
  }

  async function handleDeleteAllHistory() {
    if (!window.confirm('Delete all notification history? This cannot be undone.')) {
      return
    }
    setDeletingAll(true)
    try {
      const out = await deleteAllNotifications()
      const n = Number(out?.deleted ?? 0)
      showFlash('success', n > 0 ? `Deleted ${n} notification(s).` : 'History was already empty.')
      await loadNotifications()
    } catch (e) {
      showToast('error', e?.message || 'Delete failed')
    } finally {
      setDeletingAll(false)
    }
  }

  async function handleDeleteOne(id) {
    if (!window.confirm('Delete this notification from history?')) return
    setDeletingId(id)
    try {
      await deleteNotification(id)
      showToast('success', 'Notification deleted.')
      await loadNotifications()
    } catch (e) {
      showToast('error', e?.message || 'Delete failed')
    } finally {
      setDeletingId(null)
    }
  }

  async function loadDiagnostics() {
    setDiagBusy(true)
    try {
      const report = await getOnesignalDiagnostics()
      setDiag(report)
    } catch (e) {
      showToast('error', e?.message || 'Could not load OneSignal diagnostics')
      setDiag(null)
    } finally {
      setDiagBusy(false)
    }
  }

  async function incrementClicks(id) {
    const n = notifications.find((x) => x.id === id)
    if (!n) return
    try {
      await putNotification(id, {
        ...n,
        clicks: (Number(n.clicks) || 0) + 1,
      })
      await loadNotifications()
      showFlash('success', 'Click count updated (admin attribution).')
    } catch (e) {
      showToast('error', e?.message || 'Update failed')
    }
  }

  async function refreshAnalytics(id) {
    setRefreshingStatsId(id)
    try {
      const updated = await syncNotificationStats(id)
      if (updated?.id) {
        setNotifications((prev) => prev.map((row) => (row.id === updated.id ? updated : row)))
        if (detailRow?.id === updated.id) setDetailRow(updated)
      }
      await loadNotifications()
      if (updated?.onesignalStatsError) {
        showToast('error', updated.onesignalStatsError)
      } else {
        showFlash('success', 'Analytics refreshed from OneSignal.')
      }
    } catch (e) {
      showToast('error', e?.message || 'Analytics refresh failed')
    } finally {
      setRefreshingStatsId(null)
    }
  }

  async function cancelScheduled(n) {
    if (!window.confirm(`Cancel scheduled notification "${n.title}"?`)) return
    setScheduleActionId(n.id)
    try {
      await putNotification(n.id, {
        ...n,
        status: 'cancelled',
        scheduleAt: null,
        isActive: false,
      })
      await loadNotifications()
      showFlash('success', 'Scheduled notification cancelled.')
    } catch (e) {
      showToast('error', e?.message || 'Cancel failed')
    } finally {
      setScheduleActionId(null)
    }
  }

  function openReschedule(n) {
    setRescheduleRow(n)
    setRescheduleDate(adminDateFromIso(n.scheduleAt))
    setRescheduleTime(adminTimeFromIso(n.scheduleAt))
  }

  async function submitReschedule(e) {
    e.preventDefault()
    if (!rescheduleRow) return
    const iso = adminDateAndTimeToIso(rescheduleDate, rescheduleTime)
    if (!iso) {
      showToast('error', 'Pick a valid date and time.')
      return
    }
    if (new Date(iso).getTime() <= Date.now()) {
      showToast('error', 'Schedule must be in the future.')
      return
    }
    setScheduleActionId(rescheduleRow.id)
    try {
      await putNotification(rescheduleRow.id, {
        ...rescheduleRow,
        status: 'scheduled',
        scheduleAt: iso,
        recurrenceAnchorAt: iso,
        sentAt: null,
      })
      await loadNotifications()
      showFlash('success', `Rescheduled for ${formatAdminDateTime(iso)} (EAT).`)
      setRescheduleRow(null)
    } catch (err) {
      showToast('error', err?.message || 'Reschedule failed')
    } finally {
      setScheduleActionId(null)
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
            Notifications
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            Send push notifications to all subscribed app users via OneSignal (
            <span className="text-slate-300">Total Subscriptions</span> segment). Images are uploaded to the
            server and attached to the push when available over HTTPS; deep links are stored for in-app history.
          </p>
          <div className="mt-3">
            <button
              type="button"
              disabled={diagBusy}
              onClick={() => void loadDiagnostics()}
              className="rounded-lg border border-slate-600 bg-slate-900/80 px-3 py-1.5 text-xs font-semibold text-slate-200 hover:border-amber-500/40 hover:text-amber-200 disabled:opacity-50"
            >
              {diagBusy ? 'Checking OneSignal…' : 'Check push subscription health'}
            </button>
          </div>
          {diag ? (
            <div className="mt-3 rounded-xl border border-slate-700/60 bg-slate-900/50 p-3 text-xs text-slate-300">
              {diag.app ? (
                <p>
                  App: <span className="text-white">{diag.app.name || diag.appId}</span> · players{' '}
                  {diag.app.players ?? '—'} · messageable (push-eligible){' '}
                  <span className="font-semibold text-amber-200">{diag.app.messageable_players ?? '—'}</span>
                </p>
              ) : null}
              {diag.subscribedUsersSegment ? (
                <p className="mt-1">
                  Segment &quot;{diag.subscribedUsersSegment.name}&quot;:{' '}
                  {diag.subscribedUsersSegment.subscriber_count ?? '—'} subscribers
                </p>
              ) : null}
              {Array.isArray(diag.analysis) && diag.analysis.length > 0 ? (
                <ul className="mt-2 list-disc space-y-1 pl-4 text-slate-400">
                  {diag.analysis.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </header>

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div className="rounded-2xl border border-violet-500/25 bg-violet-950/25 p-5 ring-1 ring-violet-500/15">
            <div className="flex items-center gap-2 text-violet-300">
              <Bell className="h-5 w-5" />
              <span className="text-[10px] font-semibold uppercase tracking-wide">Campaigns sent</span>
            </div>
            <p className="mt-3 text-4xl font-bold text-white">{stats.sent}</p>
          </div>
          <div className="rounded-2xl border border-amber-500/25 bg-amber-950/20 p-4 ring-1 ring-amber-500/15">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">Scheduled</span>
            <p className="mt-2 text-3xl font-bold text-white">{stats.scheduled}</p>
          </div>
          <div className="rounded-2xl border border-emerald-500/25 bg-emerald-950/20 p-4 ring-1 ring-emerald-500/15">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-emerald-300">Delivered</span>
            <p className="mt-2 text-3xl font-bold text-white">{statNum(stats.delivered)}</p>
          </div>
          <div className="rounded-2xl border border-cyan-500/25 bg-cyan-950/25 p-5 ring-1 ring-cyan-500/15">
            <div className="flex items-center gap-2 text-cyan-300">
              <MousePointerClick className="h-5 w-5" />
              <span className="text-[10px] font-semibold uppercase tracking-wide">Clicked (OneSignal)</span>
            </div>
            <p className="mt-3 text-4xl font-bold text-white">{statNum(stats.clicked)}</p>
          </div>
          <div className="rounded-2xl border border-red-500/25 bg-red-950/20 p-4 ring-1 ring-red-500/15">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-red-300">Failed</span>
            <p className="mt-2 text-3xl font-bold text-white">{statNum(stats.failed)}</p>
          </div>
          <div className="col-span-2 rounded-2xl border border-amber-500/25 bg-amber-950/20 p-4 ring-1 ring-amber-500/15 sm:col-span-1">
            <span className="text-[10px] font-semibold uppercase tracking-wide text-amber-300">Avg CTR</span>
            <p className="mt-2 text-3xl font-bold text-white">{stats.ctr != null ? statPct(stats.ctr) : '—'}</p>
          </div>
        </section>

        {stats.scheduled > 0 ? (
          <section className="rounded-2xl border border-amber-500/30 bg-amber-950/15 p-4 ring-1 ring-amber-500/10">
            <h2 className="text-sm font-semibold text-amber-200">
              {stats.scheduled} notification{stats.scheduled === 1 ? '' : 's'} queued
            </h2>
            <ul className="mt-2 space-y-1 text-xs text-slate-300">
              {notifications
                .filter((n) => n.status === 'scheduled')
                .slice(0, 5)
                .map((n) => (
                  <li key={n.id} className="flex flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-white">{n.title}</span>
                    <span className="text-amber-200/90">
                      {n.isRecurrenceTemplate && n.recurrenceLabel
                        ? `${n.recurrenceLabel} · next ${n.scheduleAt ? formatAdminDateTime(n.scheduleAt) : '—'}`
                        : n.scheduleAt
                          ? `Sends ${formatAdminDateTime(n.scheduleAt)}`
                          : '—'}
                    </span>
                  </li>
                ))}
            </ul>
          </section>
        ) : null}

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <h2 className="text-lg font-semibold text-white">Send notification</h2>
          <form onSubmit={handleSend} className="mt-4 space-y-4">
            <div className="grid gap-4 lg:grid-cols-2">
              <div className="lg:col-span-2">
                <label className={labelClass()} htmlFor="n-title">
                  Title
                </label>
                <input
                  id="n-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className={inputClass()}
                  placeholder="Headline"
                />
                {touched && errors.title ? (
                  <p className="mt-1 text-xs text-red-400">{errors.title}</p>
                ) : null}
              </div>
              <div className="lg:col-span-2">
                <label className={labelClass()} htmlFor="n-msg">
                  Message
                </label>
                <textarea
                  id="n-msg"
                  rows={3}
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  className={`${inputClass()} min-h-[88px] resize-y`}
                  placeholder="Body text"
                />
                {touched && errors.message ? (
                  <p className="mt-1 text-xs text-red-400">{errors.message}</p>
                ) : null}
              </div>
              <div className="lg:col-span-2">
                <span className={labelClass()}>Image (optional)</span>
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,.jpg,.jpeg,.png,.webp"
                  disabled={imagePreparing || sending}
                  onChange={(ev) => void handleImage(ev)}
                  className="block w-full text-sm text-slate-400 file:mr-4 file:rounded-lg file:border-0 file:bg-amber-500/20 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-amber-200 disabled:opacity-50"
                />
                {imagePreparing ? (
                  <p className="mt-2 text-xs text-amber-200/90">Compressing and uploading…</p>
                ) : null}
                {imageUpload && !imageUpload.error ? (
                  <div className="mt-3 rounded-xl border border-emerald-500/30 bg-emerald-950/20 p-3 text-xs text-slate-300">
                    <p className="font-semibold text-emerald-200">Upload result</p>
                    <p className="mt-1">
                      Original: <span className="text-white">{formatBytes(imageUpload.originalBytes)}</span>
                      {' → '}
                      Compressed:{' '}
                      <span className="text-white">{formatBytes(imageUpload.compressedBytes)}</span>
                      {imageUpload.savedPercent != null ? (
                        <span className="text-emerald-300/90"> ({imageUpload.savedPercent}% smaller)</span>
                      ) : null}
                    </p>
                    <p className="mt-1 text-slate-400">
                      {imageUpload.width && imageUpload.height
                        ? `${imageUpload.width}×${imageUpload.height} ${String(imageUpload.format || '').toUpperCase()}`
                        : null}
                      {imageUpload.pushReady ? ' · Push image ready (HTTPS)' : ' · Saved (check CDN/HTTPS for push)'}
                    </p>
                    <p className="mt-1 text-slate-500">{imageUpload.message}</p>
                  </div>
                ) : null}
                {imageUpload?.error ? (
                  <p className="mt-2 text-xs text-red-400">{imageUpload.error}</p>
                ) : null}
                {imagePreview ? (
                  <img
                    src={imagePreview}
                    alt=""
                    className="mt-3 max-h-40 rounded-xl border border-slate-600 object-contain"
                  />
                ) : null}
                <p className="mt-1 text-xs text-slate-500">
                  Large photos from phones are resized and compressed on the server (JPG, PNG, WEBP). Shown in push
                  when served over HTTPS.
                </p>
              </div>
              <div className="lg:col-span-2">
                <label className={labelClass()}>Destination</label>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    { value: 'home', label: 'Home' },
                    { value: 'channel', label: 'Channel' },
                    { value: 'custom', label: 'Custom link' },
                  ].map((opt) => (
                    <label
                      key={opt.value}
                      className={`flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm ${
                        destinationType === opt.value
                          ? 'border-amber-500/50 bg-amber-500/10 text-amber-100'
                          : 'border-slate-600/50 bg-slate-900/60 text-slate-300'
                      }`}
                    >
                      <input
                        type="radio"
                        name="destinationType"
                        value={opt.value}
                        checked={destinationType === opt.value}
                        onChange={() => setDestinationType(opt.value)}
                        className="text-amber-500"
                      />
                      {opt.label}
                    </label>
                  ))}
                </div>
                {destinationType === 'channel' ? (
                  <div className="mt-3">
                    <label className={labelClass()} htmlFor="n-channel">
                      Channel
                    </label>
                    <select
                      id="n-channel"
                      value={selectedChannelId}
                      onChange={(e) => setSelectedChannelId(e.target.value)}
                      className={inputClass()}
                      disabled={channelsLoading}
                    >
                      <option value="">{channelsLoading ? 'Loading channels…' : 'Select channel'}</option>
                      {channels.map((ch) => (
                        <option key={ch.id} value={String(ch.id)}>
                          {ch.name} (#{ch.id})
                        </option>
                      ))}
                    </select>
                    {touched && errors.channel ? (
                      <p className="mt-1 text-xs text-red-400">{errors.channel}</p>
                    ) : null}
                  </div>
                ) : null}
                {destinationType === 'custom' ? (
                  <div className="mt-3">
                    <label className={labelClass()} htmlFor="n-link">
                      Custom deep link
                    </label>
                    <input
                      id="n-link"
                      value={customDeepLink}
                      onChange={(e) => setCustomDeepLink(e.target.value)}
                      className={inputClass()}
                      placeholder="osmani://settings"
                    />
                    {touched && errors.customDeepLink ? (
                      <p className="mt-1 text-xs text-red-400">{errors.customDeepLink}</p>
                    ) : null}
                  </div>
                ) : null}
                <p className="mt-2 text-xs text-slate-500">
                  Stored in notification payload for in-app history and optional OneSignal push data.
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-slate-600/50 bg-slate-900/40 p-4">
              <label className="flex cursor-pointer items-center gap-3">
                <input
                  type="checkbox"
                  checked={instant}
                  onChange={(e) => setInstant(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-600 bg-slate-900 text-amber-500 focus:ring-amber-500"
                />
                <span className="text-sm text-slate-200">Send immediately</span>
              </label>
              {!instant ? (
                <div className="mt-4 space-y-4">
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <label className={labelClass()}>First send — date</label>
                      <input
                        type="date"
                        value={scheduleDate}
                        onChange={(e) => setScheduleDate(e.target.value)}
                        className={inputClass()}
                      />
                    </div>
                    <div>
                      <label className={labelClass()}>First send — time</label>
                      <input
                        type="time"
                        value={scheduleTime}
                        onChange={(e) => setScheduleTime(e.target.value)}
                        className={inputClass()}
                      />
                    </div>
                    {touched && errors.schedule ? (
                      <p className="sm:col-span-2 text-xs text-red-400">{errors.schedule}</p>
                    ) : null}
                    <p className="sm:col-span-2 text-xs text-slate-500">
                      All schedule times are <strong className="text-slate-400">East Africa Time (EAT)</strong>.
                      Server stores UTC and sends when <code className="text-slate-400">schedule_at ≤ now()</code>.
                    </p>
                  </div>
                  <div>
                    <label className={labelClass()} htmlFor="n-recurrence">
                      Repeat
                    </label>
                    <select
                      id="n-recurrence"
                      value={recurrenceKind}
                      onChange={(e) => setRecurrenceKind(e.target.value)}
                      className={inputClass()}
                    >
                      {RECURRENCE_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {recurrenceKind === 'interval_minutes' || recurrenceKind === 'interval_hours' ? (
                    <div>
                      <label className={labelClass()} htmlFor="n-interval">
                        Interval ({recurrenceKind === 'interval_minutes' ? 'minutes' : 'hours'})
                      </label>
                      <input
                        id="n-interval"
                        type="number"
                        min={1}
                        value={recurrenceInterval}
                        onChange={(e) => setRecurrenceInterval(e.target.value)}
                        className={inputClass()}
                      />
                      {touched && errors.recurrenceInterval ? (
                        <p className="mt-1 text-xs text-red-400">{errors.recurrenceInterval}</p>
                      ) : null}
                    </div>
                  ) : null}
                  {recurrenceKind !== 'once' ? (
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className={labelClass()}>End date (optional)</label>
                        <input
                          type="date"
                          value={recurrenceUntilDate}
                          onChange={(e) => setRecurrenceUntilDate(e.target.value)}
                          className={inputClass()}
                        />
                      </div>
                      <div>
                        <label className={labelClass()}>End time (optional)</label>
                        <input
                          type="time"
                          value={recurrenceUntilTime}
                          onChange={(e) => setRecurrenceUntilTime(e.target.value)}
                          className={inputClass()}
                        />
                      </div>
                    </div>
                  ) : null}
                  <p className="text-xs text-slate-500">
                    Server sends when due (polled ~every 30s). Recurring jobs stay scheduled and insert a
                    sent row each time.
                  </p>
                </div>
              ) : null}
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!valid || sending || imagePreparing}
                className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-8 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-all enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? 'Working…' : instant ? 'Send notification' : 'Schedule notification'}
              </button>
            </div>
          </form>
        </section>

        <section>
          <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold text-white">History</h2>
              <p className="text-xs text-slate-500">
                Delivery stats sync from OneSignal automatically (refreshes every 15s while this page is open).
              </p>
            </div>
            <button
              type="button"
              disabled={deletingAll || notifications.length === 0}
              onClick={handleDeleteAllHistory}
              className="rounded-xl border border-red-500/40 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-200 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {deletingAll ? 'Deleting…' : 'Delete all'}
            </button>
          </div>
          <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1280px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/80 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-semibold">Title</th>
                    <th className="px-4 py-3 font-semibold">Destination</th>
                    <th className="px-4 py-3 font-semibold">Message</th>
                    <th className="px-4 py-3 font-semibold">Delivered</th>
                    <th className="px-4 py-3 font-semibold">Clicked</th>
                    <th className="px-4 py-3 font-semibold">Failed</th>
                    <th className="px-4 py-3 font-semibold">CTR</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Sent</th>
                    <th className="px-4 py-3 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {notifications.map((n) => (
                    <tr
                      key={n.id}
                      className="border-b border-slate-800/80 hover:bg-slate-900/50"
                    >
                      <td className="px-4 py-3 font-medium text-white">{n.title}</td>
                      <td className="px-4 py-3 text-xs text-slate-400">
                        <p>{destinationSummary(n)}</p>
                        {n.isRecurrenceTemplate && n.recurrenceLabel ? (
                          <p className="mt-0.5 text-sky-300/90">{n.recurrenceLabel}</p>
                        ) : null}
                      </td>
                      <td className="max-w-[200px] truncate px-4 py-3 text-slate-400">
                        {n.message}
                      </td>
                      <td className="px-4 py-3">
                        <StatBadge
                          label="Del"
                          value={analyticsMetric(n, 'onesignalDelivered')}
                          tone="emerald"
                          title={analyticsMetricTitle(n)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <StatBadge
                          label="Clk"
                          value={analyticsMetric(n, 'onesignalClicked')}
                          tone="sky"
                          title={analyticsMetricTitle(n)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <StatBadge
                          label="Fail"
                          value={analyticsMetric(n, 'onesignalFailed')}
                          tone="red"
                          title={analyticsMetricTitle(n)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <StatBadge
                          label="CTR"
                          value={analyticsMetric(n, 'onesignalCtr', { pct: true })}
                          tone="amber"
                          title={analyticsMetricTitle(n)}
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-lg px-2 py-0.5 text-[11px] font-bold uppercase ring-1 ${
                            n.status === 'sent'
                              ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
                              : n.status === 'scheduled'
                                ? 'bg-sky-500/20 text-sky-200 ring-sky-400/40'
                                : n.status === 'cancelled'
                                  ? 'bg-slate-600/30 text-slate-300 ring-slate-500/40'
                                  : n.deliveryState === 'failed'
                                    ? 'bg-red-500/20 text-red-200 ring-red-400/40'
                                    : 'bg-amber-500/20 text-amber-200 ring-amber-400/40'
                          }`}
                        >
                          {n.deliveryState === 'failed' ? 'failed' : n.status}
                        </span>
                        {n.status === 'scheduled' && n.scheduleAt ? (
                          <p className="mt-1 text-[10px] text-sky-300/90">
                            {n.isRecurrenceTemplate
                              ? `Next ${formatAdminDateTime(n.scheduleAt)}`
                              : `Due ${formatAdminDateTime(n.scheduleAt)}`}
                          </p>
                        ) : null}
                        {n.deliveryError ? (
                          <p
                            className="mt-1 max-w-[180px] truncate text-[10px] text-red-400/90"
                            title={n.deliveryError}
                          >
                            {n.deliveryError}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-400">
                        {n.status === 'scheduled' && n.scheduleAt ? (
                          <>
                            <span className="text-sky-300">Scheduled</span>
                            <p className="mt-0.5">
                              {formatAdminDateTime(n.scheduleAt)}
                              <span className="block text-[10px] text-slate-500">East Africa Time</span>
                            </p>
                          </>
                        ) : n.onesignalSentAt ? (
                          new Date(n.onesignalSentAt).toLocaleString()
                        ) : n.sentAt ? (
                          new Date(n.sentAt).toLocaleString()
                        ) : (
                          new Date(n.createdAt).toLocaleString()
                        )}
                        {n.onesignalStatsSyncedAt ? (
                          <p className="mt-0.5 text-[10px] text-slate-600" title={n.onesignalStatsSyncedAt}>
                            synced {new Date(n.onesignalStatsSyncedAt).toLocaleTimeString()}
                          </p>
                        ) : n.onesignalStatsError ? (
                          <p className="mt-0.5 text-[10px] text-red-400/80" title={n.onesignalStatsError}>
                            sync error
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex flex-col items-end gap-1 sm:flex-row sm:items-center">
                          {n.status === 'scheduled' ? (
                            <>
                              <button
                                type="button"
                                disabled={scheduleActionId === n.id}
                                onClick={() => openReschedule(n)}
                                className="rounded-lg border border-sky-500/40 bg-sky-500/10 px-2 py-1 text-xs font-medium text-sky-200 hover:bg-sky-500/20 disabled:opacity-40"
                              >
                                Reschedule
                              </button>
                              <button
                                type="button"
                                disabled={scheduleActionId === n.id}
                                onClick={() => void cancelScheduled(n)}
                                className="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-200 hover:bg-amber-500/20 disabled:opacity-40"
                              >
                                {scheduleActionId === n.id ? 'Working…' : 'Cancel'}
                              </button>
                            </>
                          ) : null}
                          {n.onesignalId || n.status === 'sent' ? (
                            <button
                              type="button"
                              disabled={refreshingStatsId === n.id}
                              onClick={() => void refreshAnalytics(n.id)}
                              className="rounded-lg border border-slate-600 px-2 py-1 text-xs font-medium text-slate-300 hover:border-cyan-500/40 hover:text-cyan-200 disabled:opacity-40"
                            >
                              {refreshingStatsId === n.id ? 'Refreshing…' : 'Refresh analytics'}
                            </button>
                          ) : null}
                          {n.onesignalId ? (
                            <button
                              type="button"
                              onClick={() => setDetailRow(n)}
                              className="rounded-lg border border-slate-600 px-2 py-1 text-xs font-medium text-slate-300 hover:border-violet-500/40 hover:text-violet-200"
                            >
                              Details
                            </button>
                          ) : null}
                          {n.status === 'sent' ? (
                            <button
                              type="button"
                              onClick={() => incrementClicks(n.id)}
                              className="rounded-lg border border-slate-600 px-2 py-1 text-xs font-medium text-slate-300 hover:border-amber-500/40 hover:text-amber-200"
                            >
                              +1 click
                            </button>
                          ) : null}
                          <button
                            type="button"
                            disabled={deletingId === n.id || deletingAll}
                            onClick={() => void handleDeleteOne(n.id)}
                            className="rounded-lg border border-red-500/40 bg-red-500/10 px-2 py-1 text-xs font-medium text-red-200 hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {deletingId === n.id ? 'Deleting…' : 'Delete'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {notifications.length === 0 ? (
              <p className="py-12 text-center text-slate-500">No notifications yet.</p>
            ) : null}
          </div>
        </section>

        {detailRow ? (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notif-detail-title"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/75"
              aria-label="Close"
              onClick={() => setDetailRow(null)}
            />
            <div className="relative z-10 w-full max-w-lg rounded-2xl border border-slate-700/80 bg-slate-950 p-6 shadow-2xl ring-1 ring-white/10">
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3 id="notif-detail-title" className="text-lg font-semibold text-white">
                    {detailRow.title}
                  </h3>
                  <p className="mt-1 text-sm text-slate-400">{detailRow.message}</p>
                </div>
                <button
                  type="button"
                  onClick={() => setDetailRow(null)}
                  className="rounded-lg border border-slate-600 p-1.5 text-slate-400 hover:text-white"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mb-4 flex flex-wrap gap-2">
                <StatBadge
                  label="Delivered"
                  value={analyticsMetric(detailRow, 'onesignalDelivered')}
                  tone="emerald"
                />
                <StatBadge
                  label="Confirmed"
                  value={analyticsMetric(detailRow, 'onesignalConfirmed')}
                  tone="emerald"
                />
                <StatBadge label="Clicked" value={analyticsMetric(detailRow, 'onesignalClicked')} tone="sky" />
                <StatBadge label="Failed" value={analyticsMetric(detailRow, 'onesignalFailed')} tone="red" />
                <StatBadge
                  label="CTR"
                  value={analyticsMetric(detailRow, 'onesignalCtr', { pct: true })}
                  tone="amber"
                />
              </div>
              {detailRow.onesignalStatsError ? (
                <div className="mb-4 rounded-xl border border-red-500/35 bg-red-950/30 p-3 text-xs text-red-200">
                  <p className="font-semibold uppercase tracking-wide text-red-300">Analytics sync error</p>
                  <p className="mt-1">{detailRow.onesignalStatsError}</p>
                </div>
              ) : null}
              <div className="mb-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={refreshingStatsId === detailRow.id}
                  onClick={() => void refreshAnalytics(detailRow.id)}
                  className="rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-1.5 text-xs font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-40"
                >
                  {refreshingStatsId === detailRow.id ? 'Refreshing…' : 'Refresh analytics'}
                </button>
              </div>
              <dl className="space-y-2 text-xs text-slate-400">
                <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                  <dt>OneSignal ID</dt>
                  <dd className="max-w-[60%] truncate font-mono text-slate-200" title={detailRow.onesignalId || ''}>
                    {detailRow.onesignalId || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                  <dt>Destination</dt>
                  <dd className="max-w-[60%] truncate text-right text-slate-200">
                    {destinationSummary(detailRow)}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                  <dt>Deep link</dt>
                  <dd className="max-w-[60%] truncate font-mono text-amber-200/90">{detailRow.targetType}</dd>
                </div>
                {detailRow.isRecurrenceTemplate || detailRow.recurrenceKind !== 'once' ? (
                  <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                    <dt>Recurrence</dt>
                    <dd className="text-slate-200">{detailRow.recurrenceLabel || detailRow.recurrenceKind}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                  <dt>Sent (OneSignal)</dt>
                  <dd className="text-slate-200">
                    {detailRow.onesignalSentAt
                      ? new Date(detailRow.onesignalSentAt).toLocaleString()
                      : detailRow.sentAt
                        ? new Date(detailRow.sentAt).toLocaleString()
                        : '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                  <dt>Stats synced</dt>
                  <dd className="text-slate-200">
                    {detailRow.onesignalStatsSyncedAt
                      ? new Date(detailRow.onesignalStatsSyncedAt).toLocaleString()
                      : 'Pending…'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                  <dt>Admin click attribution</dt>
                  <dd className="text-slate-200">{detailRow.clicks ?? 0}</dd>
                </div>
                <div className="flex justify-between gap-4 py-2">
                  <dt>Status</dt>
                  <dd className="text-slate-200">{detailRow.deliveryState === 'failed' ? 'failed' : detailRow.status}</dd>
                </div>
              </dl>
            </div>
          </div>
        ) : null}

        {rescheduleRow ? (
          <div
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 sm:p-6"
            role="dialog"
            aria-modal="true"
            aria-labelledby="notif-reschedule-title"
          >
            <button
              type="button"
              className="absolute inset-0 bg-black/75"
              aria-label="Close"
              onClick={() => setRescheduleRow(null)}
            />
            <form
              onSubmit={submitReschedule}
              className="relative z-10 w-full max-w-md rounded-2xl border border-slate-700/80 bg-slate-950 p-6 shadow-2xl ring-1 ring-white/10"
            >
              <h3 id="notif-reschedule-title" className="text-lg font-semibold text-white">
                Reschedule notification
              </h3>
              <p className="mt-1 text-sm text-slate-400">{rescheduleRow.title}</p>
              <div className="mt-4 grid gap-3 sm:grid-cols-2">
                <div>
                  <label className={labelClass()}>Date</label>
                  <input
                    type="date"
                    value={rescheduleDate}
                    onChange={(e) => setRescheduleDate(e.target.value)}
                    className={inputClass()}
                    required
                  />
                </div>
                <div>
                  <label className={labelClass()}>Time</label>
                  <input
                    type="time"
                    value={rescheduleTime}
                    onChange={(e) => setRescheduleTime(e.target.value)}
                    className={inputClass()}
                    required
                  />
                </div>
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setRescheduleRow(null)}
                  className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={scheduleActionId === rescheduleRow.id}
                  className="rounded-lg bg-amber-500 px-4 py-2 text-sm font-semibold text-slate-950 disabled:opacity-40"
                >
                  {scheduleActionId === rescheduleRow.id ? 'Saving…' : 'Save schedule'}
                </button>
              </div>
            </form>
          </div>
        ) : null}
      </main>
    </>
  )
}

export default NotificationsPage
