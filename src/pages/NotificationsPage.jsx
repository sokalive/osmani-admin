import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, MousePointerClick, X } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  deleteAllNotifications,
  deleteNotification,
  getNotifications,
  getOnesignalDiagnostics,
  postNotification,
  putNotification,
  syncStreamUrl,
} from '../lib/api'

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

function StatBadge({ label, value, tone = 'slate' }) {
  const tones = {
    emerald: 'border-emerald-500/35 bg-emerald-500/15 text-emerald-100',
    sky: 'border-sky-500/35 bg-sky-500/15 text-sky-100',
    red: 'border-red-500/35 bg-red-500/15 text-red-100',
    amber: 'border-amber-500/35 bg-amber-500/15 text-amber-100',
    slate: 'border-slate-600/50 bg-slate-800/60 text-slate-200',
  }
  return (
    <span
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
    } catch (e) {
      showToast('error', e?.message || 'Could not load notifications')
      setNotifications([])
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
  const [targetType, setTargetType] = useState('osmani://home')
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

  const showFlash = useCallback((type, msg) => {
    setFlash({ type, message: msg })
    window.setTimeout(() => setFlash(null), 4500)
  }, [])

  const stats = useMemo(() => {
    const sentRows = notifications.filter((n) => n.status === 'sent')
    const sent = sentRows.length
    const delivered = sentRows.reduce((s, n) => s + (Number(n.onesignalDelivered) || 0), 0)
    const clicked = sentRows.reduce((s, n) => s + (Number(n.onesignalClicked) || 0), 0)
    const failed = sentRows.reduce((s, n) => s + (Number(n.onesignalFailed) || 0), 0)
    const ctr = delivered > 0 ? Math.round((clicked / delivered) * 1000) / 10 : null
    return { sent, delivered, clicked, failed, ctr }
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
    if (!targetType.trim()) e.targetType = 'Deep link is required'
    if (!instant) {
      if (!scheduleDate) e.schedule = 'Pick a date'
      else if (!scheduleTime) e.schedule = 'Pick a time'
      else {
        const iso = `${scheduleDate}T${scheduleTime}:00`
        const at = new Date(iso)
        if (Number.isNaN(at.getTime())) e.schedule = 'Invalid schedule'
        else if (at.getTime() <= Date.now()) e.schedule = 'Schedule must be in the future'
      }
    }
    return e
  }, [title, message, targetType, instant, scheduleDate, scheduleTime])

  const valid = Object.keys(errors).length === 0

  function handleImage(e) {
    const file = e.target.files?.[0]
    if (!file) return
    if (file.size > 450 * 1024) {
      showFlash('error', 'Image must be under 450 KB.')
      return
    }
    if (imagePreview?.startsWith('blob:')) URL.revokeObjectURL(imagePreview)
    const reader = new FileReader()
    reader.onload = () => {
      setImageData(typeof reader.result === 'string' ? reader.result : '')
      setImagePreview(typeof reader.result === 'string' ? reader.result : URL.createObjectURL(file))
    }
    reader.readAsDataURL(file)
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
      const iso = instant ? null : `${scheduleDate}T${scheduleTime}:00`
      const created = await postNotification({
        title: title.trim(),
        message: message.trim(),
        image: imageData || '',
        targetAudience: 'all',
        targetType: targetType.trim(),
        scheduleAt: instant ? null : new Date(iso).toISOString(),
        status: instant ? 'sent' : 'scheduled',
        sentAt: instant ? new Date().toISOString() : null,
        clicks: 0,
      })
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
        showFlash('success', 'Notification scheduled; OneSignal will send at the chosen time.')
      }
      setTitle('')
      setMessage('')
      setImageData('')
      setImagePreview(null)
      setTargetType('osmani://home')
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

        <section className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          <div className="rounded-2xl border border-violet-500/25 bg-violet-950/25 p-5 ring-1 ring-violet-500/15">
            <div className="flex items-center gap-2 text-violet-300">
              <Bell className="h-5 w-5" />
              <span className="text-[10px] font-semibold uppercase tracking-wide">Campaigns sent</span>
            </div>
            <p className="mt-3 text-4xl font-bold text-white">{stats.sent}</p>
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
                  accept="image/*"
                  onChange={handleImage}
                  className="block w-full text-sm text-slate-400 file:mr-4 file:rounded-lg file:border-0 file:bg-amber-500/20 file:px-4 file:py-2 file:text-sm file:font-semibold file:text-amber-200"
                />
                {imagePreview ? (
                  <img
                    src={imagePreview}
                    alt=""
                    className="mt-3 max-h-40 rounded-xl border border-slate-600 object-contain"
                  />
                ) : null}
                <p className="mt-1 text-xs text-slate-500">
                  Shown in push (Android/iOS) when the server can serve it over HTTPS.
                </p>
              </div>
              <div>
                <label className={labelClass()}>Audience</label>
                <p className="rounded-xl border border-slate-600/50 bg-slate-900/60 px-3 py-2.5 text-sm text-slate-200">
                  All users
                </p>
                <p className="mt-1 text-xs text-slate-500">OneSignal segment: Total Subscriptions</p>
              </div>
              <div>
                <label className={labelClass()} htmlFor="n-link">
                  Deep link (in-app)
                </label>
                <input
                  id="n-link"
                  value={targetType}
                  onChange={(e) => setTargetType(e.target.value)}
                  className={inputClass()}
                  placeholder="osmani://home"
                />
                {touched && errors.targetType ? (
                  <p className="mt-1 text-xs text-red-400">{errors.targetType}</p>
                ) : null}
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
                <div className="mt-4 grid gap-3 sm:grid-cols-2">
                  <div>
                    <label className={labelClass()}>Schedule date</label>
                    <input
                      type="date"
                      value={scheduleDate}
                      onChange={(e) => setScheduleDate(e.target.value)}
                      className={inputClass()}
                    />
                  </div>
                  <div>
                    <label className={labelClass()}>Schedule time</label>
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
                </div>
              ) : null}
            </div>

            <div className="flex justify-end">
              <button
                type="submit"
                disabled={!valid || sending}
                className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-8 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] transition-all enabled:hover:scale-[1.02] disabled:cursor-not-allowed disabled:opacity-40"
              >
                {sending ? 'Working…' : 'Send notification'}
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
              <table className="w-full min-w-[1100px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/80 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-semibold">Title</th>
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
                      <td className="max-w-[200px] truncate px-4 py-3 text-slate-400">
                        {n.message}
                      </td>
                      <td className="px-4 py-3">
                        <StatBadge label="Del" value={statNum(n.onesignalDelivered)} tone="emerald" />
                      </td>
                      <td className="px-4 py-3">
                        <StatBadge label="Clk" value={statNum(n.onesignalClicked)} tone="sky" />
                      </td>
                      <td className="px-4 py-3">
                        <StatBadge label="Fail" value={statNum(n.onesignalFailed)} tone="red" />
                      </td>
                      <td className="px-4 py-3">
                        <StatBadge
                          label="CTR"
                          value={n.onesignalCtr != null ? statPct(n.onesignalCtr) : '—'}
                          tone="amber"
                        />
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-lg px-2 py-0.5 text-[11px] font-bold uppercase ring-1 ${
                            n.status === 'sent'
                              ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
                              : n.deliveryState === 'failed'
                                ? 'bg-red-500/20 text-red-200 ring-red-400/40'
                                : 'bg-amber-500/20 text-amber-200 ring-amber-400/40'
                          }`}
                        >
                          {n.deliveryState === 'failed' ? 'failed' : n.status}
                        </span>
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
                        {n.onesignalSentAt
                          ? new Date(n.onesignalSentAt).toLocaleString()
                          : n.sentAt
                            ? new Date(n.sentAt).toLocaleString()
                            : n.scheduleAt
                              ? `Due ${new Date(n.scheduleAt).toLocaleString()}`
                              : new Date(n.createdAt).toLocaleString()}
                        {n.onesignalStatsSyncedAt ? (
                          <p className="mt-0.5 text-[10px] text-slate-600" title={n.onesignalStatsSyncedAt}>
                            synced {new Date(n.onesignalStatsSyncedAt).toLocaleTimeString()}
                          </p>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="inline-flex flex-col items-end gap-1 sm:flex-row sm:items-center">
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
                <StatBadge label="Delivered" value={statNum(detailRow.onesignalDelivered)} tone="emerald" />
                <StatBadge label="Confirmed" value={statNum(detailRow.onesignalConfirmed)} tone="emerald" />
                <StatBadge label="Clicked" value={statNum(detailRow.onesignalClicked)} tone="sky" />
                <StatBadge label="Failed" value={statNum(detailRow.onesignalFailed)} tone="red" />
                <StatBadge
                  label="CTR"
                  value={detailRow.onesignalCtr != null ? statPct(detailRow.onesignalCtr) : '—'}
                  tone="amber"
                />
              </div>
              <dl className="space-y-2 text-xs text-slate-400">
                <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                  <dt>OneSignal ID</dt>
                  <dd className="max-w-[60%] truncate font-mono text-slate-200" title={detailRow.onesignalId || ''}>
                    {detailRow.onesignalId || '—'}
                  </dd>
                </div>
                <div className="flex justify-between gap-4 border-b border-slate-800/80 py-2">
                  <dt>Deep link</dt>
                  <dd className="max-w-[60%] truncate font-mono text-amber-200/90">{detailRow.targetType}</dd>
                </div>
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
      </main>
    </>
  )
}

export default NotificationsPage
