import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, MessageSquare, Send, Wifi, XCircle } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import SmsHistorySection from '../components/SmsHistorySection'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  getBeemSettings,
  getSmsRecipientCounts,
  getSmsTemplates,
  postBeemTest,
  postSmsSend,
  putBeemSettings,
  putSmsTemplate,
  syncStreamUrl,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function SmsCenterPage() {
  const { showToast } = useToast()
  const [flash, setFlash] = useState(null)
  const [tab, setTab] = useState('send')

  const [beem, setBeem] = useState({ enabled: false, credentialsReady: false })
  const [beemDraft, setBeemDraft] = useState({ enabled: false, apiKey: '', secretKey: '', senderName: '' })
  const [beemSaving, setBeemSaving] = useState(false)
  const [beemTesting, setBeemTesting] = useState(false)

  const [templates, setTemplates] = useState([])
  const [templateDrafts, setTemplateDrafts] = useState({})
  const [templateSaving, setTemplateSaving] = useState(null)

  const [counts, setCounts] = useState({ all: 0, active: 0, expired: 0 })
  const [audience, setAudience] = useState('active')
  const [customMessage, setCustomMessage] = useState('')
  const [singlePhone, setSinglePhone] = useState('')
  const [singleDeviceId, setSingleDeviceId] = useState('')
  const [sending, setSending] = useState(false)

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  const loadBeem = useCallback(async () => {
    try {
      const s = await getBeemSettings()
      setBeem(s)
      setBeemDraft((d) => ({
        ...d,
        enabled: Boolean(s?.enabled),
        senderName: String(s?.senderName ?? s?.sender_name ?? ''),
        apiKey: '',
        secretKey: '',
      }))
    } catch (e) {
      showToast('error', e?.message || 'Could not load Beem settings')
    }
  }, [showToast])

  const loadTemplates = useCallback(async () => {
    try {
      const list = await getSmsTemplates()
      const arr = Array.isArray(list) ? list : []
      setTemplates(arr)
      const drafts = {}
      for (const t of arr) {
        drafts[t.templateKey] = { body: t.body, enabled: t.enabled !== false }
      }
      setTemplateDrafts(drafts)
    } catch (e) {
      showToast('error', e?.message || 'Could not load SMS templates')
    }
  }, [showToast])

  const loadCounts = useCallback(async () => {
    try {
      const c = await getSmsRecipientCounts()
      setCounts(c)
    } catch {
      setCounts({ all: 0, active: 0, expired: 0 })
    }
  }, [])

  useEffect(() => {
    void loadBeem()
    void loadTemplates()
    void loadCounts()
  }, [loadBeem, loadTemplates, loadCounts])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    es.addEventListener('config.beem_settings_changed', () => void loadBeem())
    return () => es.close()
  }, [loadBeem])

  const beemDirty = useMemo(
    () =>
      beemDraft.enabled !== beem.enabled ||
      beemDraft.senderName !== String(beem.senderName ?? '') ||
      beemDraft.apiKey.trim() !== '' ||
      beemDraft.secretKey.trim() !== '',
    [beemDraft, beem],
  )

  async function handleSaveBeem(e) {
    e.preventDefault()
    setBeemSaving(true)
    try {
      const payload = {
        enabled: beemDraft.enabled,
        senderName: beemDraft.senderName.trim(),
      }
      if (beemDraft.apiKey.trim()) payload.apiKey = beemDraft.apiKey.trim()
      if (beemDraft.secretKey.trim()) payload.secretKey = beemDraft.secretKey.trim()
      const saved = await putBeemSettings(payload)
      setBeem(saved)
      setBeemDraft((d) => ({ ...d, apiKey: '', secretKey: '' }))
      showFlash('success', 'Beem SMS settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    } finally {
      setBeemSaving(false)
    }
  }

  async function handleTestBeem() {
    setBeemTesting(true)
    try {
      const r = await postBeemTest()
      showFlash(r?.success ? 'success' : 'error', r?.message || (r?.success ? 'OK' : 'Failed'))
      void loadBeem()
    } catch (err) {
      showToast('error', err?.message || 'Test failed')
    } finally {
      setBeemTesting(false)
    }
  }

  async function handleSaveTemplate(key) {
    setTemplateSaving(key)
    try {
      const d = templateDrafts[key] || {}
      await putSmsTemplate(key, { body: d.body, enabled: d.enabled !== false })
      showFlash('success', `Template "${key}" saved.`)
      void loadTemplates()
    } catch (err) {
      showToast('error', err?.message || 'Template save failed')
    } finally {
      setTemplateSaving(null)
    }
  }

  async function handleSendSms(e) {
    e.preventDefault()
    const msg = customMessage.trim()
    if (!msg) {
      showToast('error', 'Enter a message')
      return
    }
    setSending(true)
    try {
      const body = singlePhone.trim() || singleDeviceId.trim()
        ? {
            message: msg,
            phone: singlePhone.trim() || undefined,
            deviceId: singleDeviceId.trim() || undefined,
          }
        : { message: msg, audience }
      const r = await postSmsSend(body)
      if (r?.ok === false && r?.skipped) {
        showToast('error', r?.reason || 'SMS not sent')
      } else {
        showFlash('success', `SMS sent (${r?.sent ?? 1} recipient(s)).`)
        setCustomMessage('')
      }
    } catch (err) {
      showToast('error', err?.message || 'Send failed')
    } finally {
      setSending(false)
    }
  }

  const gatewayLive = beem.enabled === true && beem.credentialsReady === true

  const tabs = [
    { id: 'send', label: 'Send SMS' },
    { id: 'templates', label: 'Templates' },
    { id: 'settings', label: 'Beem Settings' },
    { id: 'history', label: 'History' },
  ]

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-sky-500/20 p-3 ring-1 ring-sky-400/40">
              <MessageSquare className="h-7 w-7 text-sky-300" />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-white sm:text-3xl">SMS Center</h1>
              <p className="mt-1 text-sm text-slate-400">
                Beem SMS for subscription alerts and admin broadcasts. Push notifications are unchanged.
              </p>
            </div>
          </div>
          <div
            className={`rounded-xl border px-4 py-3 ${
              gatewayLive
                ? 'border-emerald-500/40 bg-emerald-500/10'
                : 'border-slate-600/50 bg-slate-900/50'
            }`}
          >
            <p className="text-xs font-semibold uppercase text-slate-400">Gateway</p>
            <p className="mt-1 flex items-center gap-2 text-sm font-semibold">
              {gatewayLive ? (
                <>
                  <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                  <span className="text-emerald-200">Live</span>
                </>
              ) : (
                <>
                  <XCircle className="h-4 w-4 text-slate-500" />
                  <span className="text-slate-400">Disabled / not configured</span>
                </>
              )}
            </p>
          </div>
        </header>

        <div className="flex flex-wrap gap-2 border-b border-slate-700/60 pb-1">
          {tabs.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`rounded-t-lg px-4 py-2 text-sm font-medium transition-colors ${
                tab === t.id
                  ? 'bg-amber-500/15 text-amber-200 ring-1 ring-amber-500/30'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'settings' ? (
          <form onSubmit={handleSaveBeem} className="max-w-2xl space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6">
            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-600/50 bg-slate-900/50 px-4 py-3">
              <input
                type="checkbox"
                checked={beemDraft.enabled}
                onChange={(e) => setBeemDraft((d) => ({ ...d, enabled: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-500 text-amber-500"
              />
              <div>
                <p className="text-sm font-semibold text-slate-200">Enable Beem SMS</p>
                <p className="text-xs text-slate-500">When off, no SMS is sent (automated or manual).</p>
              </div>
            </label>
            <div>
              <label className={labelClass()}>API key (BEEM_API_KEY)</label>
              <input
                type="password"
                value={beemDraft.apiKey}
                onChange={(e) => setBeemDraft((d) => ({ ...d, apiKey: e.target.value }))}
                placeholder={beem.hasApiKey ? 'Saved — enter to replace' : 'Beem API key'}
                className={inputClass()}
                autoComplete="off"
              />
            </div>
            <div>
              <label className={labelClass()}>Secret key (BEEM_SECRET_KEY)</label>
              <input
                type="password"
                value={beemDraft.secretKey}
                onChange={(e) => setBeemDraft((d) => ({ ...d, secretKey: e.target.value }))}
                placeholder={beem.hasSecretKey ? 'Saved — enter to replace' : 'Beem secret key'}
                className={inputClass()}
                autoComplete="off"
              />
            </div>
            <div>
              <label className={labelClass()}>Sender name (BEEM_SENDER_NAME)</label>
              <input
                value={beemDraft.senderName}
                onChange={(e) => setBeemDraft((d) => ({ ...d, senderName: e.target.value }))}
                placeholder="OSMANITVMAX"
                className={inputClass()}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Beem-approved sender ID only — max 11 letters/numbers, no spaces (e.g. OSMANITVMAX).
              </p>
            </div>
            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={handleTestBeem}
                disabled={beemTesting}
                className="inline-flex items-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-200 disabled:opacity-50"
              >
                {beemTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wifi className="h-4 w-4" />}
                Test connection
              </button>
              <button
                type="submit"
                disabled={!beemDirty || beemSaving}
                className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-40"
              >
                {beemSaving ? 'Saving…' : 'Save settings'}
              </button>
            </div>
            {beem.lastTestAt ? (
              <p className="text-xs text-slate-500">
                Last test: {formatAdminDateTime(beem.lastTestAt)} —{' '}
                {beem.lastTestOk ? 'OK' : 'Failed'} {beem.lastTestMessage ? `(${beem.lastTestMessage})` : ''}
              </p>
            ) : null}
          </form>
        ) : null}

        {tab === 'templates' ? (
          <div className="space-y-6">
            {templates.map((t) => {
              const key = t.templateKey
              const d = templateDrafts[key] || { body: t.body, enabled: true }
              return (
                <div
                  key={key}
                  className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-5 ring-1 ring-white/[0.04]"
                >
                  <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="font-mono text-sm font-semibold text-amber-300">{key}</p>
                      <p className="text-xs text-slate-500">{t.description}</p>
                    </div>
                    <label className="flex items-center gap-2 text-sm text-slate-300">
                      <input
                        type="checkbox"
                        checked={d.enabled !== false}
                        onChange={(e) =>
                          setTemplateDrafts((prev) => ({
                            ...prev,
                            [key]: { ...d, enabled: e.target.checked },
                          }))
                        }
                        className="h-4 w-4 rounded border-slate-500 text-amber-500"
                      />
                      Enabled
                    </label>
                  </div>
                  <textarea
                    value={d.body}
                    onChange={(e) =>
                      setTemplateDrafts((prev) => ({
                        ...prev,
                        [key]: { ...d, body: e.target.value },
                      }))
                    }
                    rows={3}
                    className={inputClass()}
                  />
                  <button
                    type="button"
                    onClick={() => handleSaveTemplate(key)}
                    disabled={templateSaving === key}
                    className="mt-3 rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-200 hover:bg-slate-800 disabled:opacity-50"
                  >
                    {templateSaving === key ? 'Saving…' : 'Save template'}
                  </button>
                </div>
              )
            })}
          </div>
        ) : null}

        {tab === 'send' ? (
          <form onSubmit={handleSendSms} className="grid gap-6 lg:grid-cols-2">
            <div className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">Broadcast</h2>
              <p className="text-xs text-slate-500">
                Recipients with phone numbers: all {counts.all}, active {counts.active}, expired{' '}
                {counts.expired}
              </p>
              <div className="space-y-2">
                {[
                  { id: 'all', label: 'All users' },
                  { id: 'active', label: 'Active subscribers only' },
                  { id: 'expired', label: 'Expired subscribers only' },
                ].map((opt) => (
                  <label key={opt.id} className="flex cursor-pointer items-center gap-2 text-sm text-slate-200">
                    <input
                      type="radio"
                      name="smsAudience"
                      checked={audience === opt.id && !singlePhone.trim() && !singleDeviceId.trim()}
                      onChange={() => {
                        setAudience(opt.id)
                        setSinglePhone('')
                        setSingleDeviceId('')
                      }}
                      className="h-4 w-4 border-slate-500 text-amber-500"
                    />
                    {opt.label}
                  </label>
                ))}
              </div>
            </div>
            <div className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6">
              <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">Single user</h2>
              <div>
                <label className={labelClass()}>Phone</label>
                <input
                  value={singlePhone}
                  onChange={(e) => setSinglePhone(e.target.value)}
                  placeholder="07XXXXXXXX or +255…"
                  className={inputClass()}
                />
              </div>
              <div>
                <label className={labelClass()}>Or device ID</label>
                <input
                  value={singleDeviceId}
                  onChange={(e) => setSingleDeviceId(e.target.value)}
                  placeholder="device_id"
                  className={inputClass()}
                />
              </div>
            </div>
            <div className="lg:col-span-2 space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6">
              <label className={labelClass()}>Message</label>
              <textarea
                value={customMessage}
                onChange={(e) => setCustomMessage(e.target.value)}
                rows={4}
                className={inputClass()}
                placeholder="Type your SMS message…"
              />
              <button
                type="submit"
                disabled={sending}
                className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-5 py-3 text-sm font-semibold text-emerald-200 disabled:opacity-50"
              >
                {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                Send SMS
              </button>
            </div>
          </form>
        ) : null}

        {tab === 'history' ? <SmsHistorySection /> : null}
      </main>
    </>
  )
}

export default SmsCenterPage
