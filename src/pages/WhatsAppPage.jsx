import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExternalLink, MessageCircle } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getWhatsappSettings, putWhatsappSettings, syncStreamUrl } from '../lib/api'

function defaultWa() {
  return { enabled: true, url: 'https://wa.me/255712345678' }
}

function isValidWhatsAppUrl(url) {
  try {
    const u = new URL(url.trim())
    const h = u.hostname.toLowerCase()
    if (h === 'wa.me' || h.endsWith('.wa.me')) return true
    if (h === 'api.whatsapp.com') return true
    return false
  } catch {
    return false
  }
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function WhatsAppPage() {
  const { showToast } = useToast()
  const [stored, setStored] = useState(() => defaultWa())
  const [draft, setDraft] = useState(() => ({ ...defaultWa() }))
  const [flash, setFlash] = useState(null)

  const load = useCallback(async () => {
    try {
      const s = await getWhatsappSettings()
      const merged = { ...defaultWa(), ...s }
      setStored(merged)
      setDraft(merged)
    } catch (e) {
      showToast('error', e?.message || 'Could not load WhatsApp settings')
    }
  }, [showToast])

  useEffect(() => {
    load()
  }, [load])

  const valid = useMemo(() => isValidWhatsAppUrl(draft.url), [draft.url])
  const dirty = draft.url !== stored.url || draft.enabled !== stored.enabled

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!isValidWhatsAppUrl(draft.url)) {
      showFlash('error', 'Use a wa.me or api.whatsapp.com URL only.')
      return
    }
    try {
      const saved = await putWhatsappSettings({
        enabled: Boolean(draft.enabled),
        url: draft.url.trim(),
      })
      setStored(saved)
      setDraft(saved)
      showFlash('success', 'WhatsApp link saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  function handleTest() {
    if (!isValidWhatsAppUrl(draft.url)) {
      showFlash('error', 'Fix the URL before testing.')
      return
    }
    window.open(draft.url.trim(), '_blank', 'noopener,noreferrer')
  }

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onChanged = () => {
      void load()
    }
    es.addEventListener('whatsapp_settings_changed', onChanged)
    return () => es.close()
  }, [load])

  return (
    <>
      <Topbar />
      <main className="mt-6 flex max-w-3xl flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header className="flex items-start gap-3">
          <div className="rounded-xl bg-emerald-500/20 p-3 ring-1 ring-emerald-400/40">
            <MessageCircle className="h-7 w-7 text-emerald-300" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">WhatsApp Support</h1>
            <p className="mt-1 text-sm text-slate-400">
              Official chat entry point — must use supported WhatsApp URL formats.
            </p>
          </div>
        </header>

        <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
          <label className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400">
            WhatsApp link
          </label>
          <input
            value={draft.url}
            onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
            className={inputClass()}
            placeholder="https://wa.me/255712345678"
          />
          {!valid && draft.url.trim() ? (
            <p className="mt-2 text-xs text-red-400">
              Allowed hosts: <span className="font-mono">wa.me</span> or{' '}
              <span className="font-mono">api.whatsapp.com</span>
            </p>
          ) : null}

          <div className="mt-5 rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Current saved link
            </p>
            <p className="mt-1 break-all font-mono text-sm text-emerald-200/95">{stored.url || '—'}</p>
          </div>

          <div className="mt-6 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={handleSave}
              disabled={!dirty || !valid}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:cursor-not-allowed disabled:opacity-40"
            >
              Save
            </button>
            <button
              type="button"
              onClick={handleTest}
              disabled={!valid}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-6 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800 disabled:opacity-40"
            >
              <ExternalLink className="h-4 w-4" />
              Test link
            </button>
          </div>
        </section>
      </main>
    </>
  )
}

export default WhatsAppPage
