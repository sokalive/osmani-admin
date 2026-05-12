import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bell, MousePointerClick } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getNotifications, postNotification, putNotification, syncStreamUrl } from '../lib/api'

const AUDIENCES = [
  { value: 'all', label: 'All users' },
  { value: 'premium', label: 'Premium subscribers' },
  { value: 'trial', label: 'Free trial' },
  { value: 'inactive', label: 'Inactive / lapsed' },
]

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
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
    }, 60_000)
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
  const [targetAudience, setTargetAudience] = useState('all')
  const [targetType, setTargetType] = useState('osmani://home')
  const [scheduleDate, setScheduleDate] = useState('')
  const [scheduleTime, setScheduleTime] = useState('')
  const [instant, setInstant] = useState(true)
  const [touched, setTouched] = useState(false)
  const [sending, setSending] = useState(false)
  const [flash, setFlash] = useState(null)

  const showFlash = useCallback((type, msg) => {
    setFlash({ type, message: msg })
    window.setTimeout(() => setFlash(null), 4500)
  }, [])

  const stats = useMemo(() => {
    const sent = notifications.filter((n) => n.status === 'sent').length
    const clicks = notifications.reduce((s, n) => s + (Number(n.clicks) || 0), 0)
    return { sent, clicks }
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
      await postNotification({
        title: title.trim(),
        message: message.trim(),
        image: imageData || '',
        targetAudience,
        targetType: targetType.trim(),
        scheduleAt: instant ? null : new Date(iso).toISOString(),
        status: instant ? 'sent' : 'scheduled',
        sentAt: instant ? new Date().toISOString() : null,
        clicks: 0,
      })
      await loadNotifications()
      showFlash('success', instant ? 'Notification saved.' : 'Notification scheduled.')
      setTitle('')
      setMessage('')
      setImageData('')
      setImagePreview(null)
      setTargetAudience('all')
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
            Compose campaigns, schedule sends, and review performance
          </p>
        </header>

        <section className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="rounded-2xl border border-violet-500/25 bg-violet-950/25 p-5 ring-1 ring-violet-500/15">
            <div className="flex items-center gap-2 text-violet-300">
              <Bell className="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-wide">Total sent</span>
            </div>
            <p className="mt-3 text-4xl font-bold text-white">{stats.sent}</p>
          </div>
          <div className="rounded-2xl border border-cyan-500/25 bg-cyan-950/25 p-5 ring-1 ring-cyan-500/15">
            <div className="flex items-center gap-2 text-cyan-300">
              <MousePointerClick className="h-5 w-5" />
              <span className="text-xs font-semibold uppercase tracking-wide">Total clicks</span>
            </div>
            <p className="mt-3 text-4xl font-bold text-white">{stats.clicks}</p>
          </div>
        </section>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <h2 className="text-lg font-semibold text-white">Create notification</h2>
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
              </div>
              <div>
                <label className={labelClass()} htmlFor="n-aud">
                  Target audience
                </label>
                <select
                  id="n-aud"
                  value={targetAudience}
                  onChange={(e) => setTargetAudience(e.target.value)}
                  className={inputClass()}
                >
                  {AUDIENCES.map((a) => (
                    <option key={a.value} value={a.value}>
                      {a.label}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={labelClass()} htmlFor="n-link">
                  Target type (deep link)
                </label>
                <input
                  id="n-link"
                  value={targetType}
                  onChange={(e) => setTargetType(e.target.value)}
                  className={inputClass()}
                  placeholder="osmani://channel/…"
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
          <h2 className="mb-4 text-lg font-semibold text-white">History</h2>
          <div className="overflow-hidden rounded-2xl border border-slate-700/60 bg-slate-950/40 ring-1 ring-white/[0.04]">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-700/80 bg-slate-900/50 text-xs uppercase tracking-wide text-slate-400">
                    <th className="px-4 py-3 font-semibold">Title</th>
                    <th className="px-4 py-3 font-semibold">Message</th>
                    <th className="px-4 py-3 font-semibold">Target</th>
                    <th className="px-4 py-3 font-semibold">Link</th>
                    <th className="px-4 py-3 font-semibold">Clicks</th>
                    <th className="px-4 py-3 font-semibold">Status</th>
                    <th className="px-4 py-3 font-semibold">Date</th>
                    <th className="px-4 py-3 font-semibold text-right">Action</th>
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
                      <td className="px-4 py-3 text-slate-300">{n.targetAudience}</td>
                      <td className="max-w-[140px] truncate px-4 py-3 font-mono text-xs text-amber-200/90">
                        {n.targetType}
                      </td>
                      <td className="px-4 py-3 text-slate-200">{n.clicks ?? 0}</td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-lg px-2 py-0.5 text-[11px] font-bold uppercase ring-1 ${
                            n.status === 'sent'
                              ? 'bg-emerald-500/20 text-emerald-200 ring-emerald-400/40'
                              : 'bg-amber-500/20 text-amber-200 ring-amber-400/40'
                          }`}
                        >
                          {n.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-400">
                        {n.sentAt
                          ? new Date(n.sentAt).toLocaleString()
                          : n.scheduleAt
                            ? `Due ${new Date(n.scheduleAt).toLocaleString()}`
                            : new Date(n.createdAt).toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {n.status === 'sent' ? (
                          <button
                            type="button"
                            onClick={() => incrementClicks(n.id)}
                            className="rounded-lg border border-slate-600 px-2 py-1 text-xs font-medium text-slate-300 hover:border-amber-500/40 hover:text-amber-200"
                          >
                            +1 click
                          </button>
                        ) : (
                          <span className="text-xs text-slate-600">—</span>
                        )}
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
          <p className="mt-2 text-xs text-slate-500">
            “+1 click” records attributed opens when reconciling analytics with your push backend.
          </p>
        </section>
      </main>
    </>
  )
}

export default NotificationsPage
