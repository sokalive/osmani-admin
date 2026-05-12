import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, X } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getRuntimePopupSettings, putRuntimePopupSettings, syncStreamUrl } from '../lib/api'

function normalizeRuntimePopup(payload) {
  const body = payload && typeof payload === 'object' ? payload : {}
  const mode = String(body.mode ?? '').trim().toLowerCase()
  const bulletsSource = Array.isArray(body.bullets)
    ? body.bullets
    : Array.isArray(body.bullet_points)
      ? body.bullet_points
      : []
  return {
    mode: ['once', 'always', 'disabled'].includes(mode) ? mode : 'once',
    title: String(body.title ?? ''),
    greeting: String(body.greeting ?? ''),
    bullets: bulletsSource.map((item) => String(item ?? '').trim()).filter(Boolean),
    disclaimer: String(body.disclaimer ?? ''),
  }
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function PopupSettingsPage() {
  const { showToast } = useToast()
  const [saved, setSaved] = useState(null)
  const [draft, setDraft] = useState(null)
  const [loading, setLoading] = useState(true)
  const [previewOpen, setPreviewOpen] = useState(false)
  const [flash, setFlash] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await getRuntimePopupSettings()
      const normalized = normalizeRuntimePopup(payload)
      setSaved(normalized)
      setDraft(normalized)
    } catch (e) {
      showToast('error', e?.message || 'Could not load popup settings')
    } finally {
      setLoading(false)
    }
  }, [showToast])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [load])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onChanged = () => {
      void load()
    }
    es.addEventListener('popup_settings_changed', onChanged)
    return () => es.close()
  }, [load])

  const dirty = useMemo(() => {
    if (!draft || !saved) return false
    return JSON.stringify(draft) !== JSON.stringify(saved)
  }, [draft, saved])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!draft) return
    if (!draft.title.trim()) {
      showFlash('error', 'Title is required.')
      return
    }
    try {
      await putRuntimePopupSettings({
        mode: draft.mode,
        title: draft.title,
        greeting: draft.greeting,
        bullets: draft.bullets,
        disclaimer: draft.disclaimer,
      })
      await load()
      showFlash('success', 'Popup settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  const bulletsText = Array.isArray(draft?.bullets) ? draft.bullets.join('\n') : ''

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h1 className="text-2xl font-bold text-white sm:text-3xl">Popup Settings</h1>
            <p className="mt-1 text-sm text-slate-400">Home-screen announcement content</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => setPreviewOpen(true)}
              disabled={!draft}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-5 py-3 text-sm font-semibold text-slate-200 hover:bg-slate-800"
            >
              <Eye className="h-4 w-4" />
              Preview popup
            </button>
            <button
              type="submit"
              form="popup-form"
              disabled={!dirty}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:opacity-40"
            >
              Save
            </button>
          </div>
        </header>

        <form id="popup-form" onSubmit={handleSave} className="space-y-6">
          <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Display mode</p>
            <div className="mt-4 flex flex-wrap gap-3">
              {[
                { id: 'once', label: 'Show once' },
                { id: 'always', label: 'Always show' },
                { id: 'disabled', label: 'Disabled' },
              ].map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setDraft((d) => (d ? { ...d, mode: opt.id } : d))}
                  disabled={!draft}
                  className={`rounded-xl border px-5 py-3 text-sm font-semibold transition-colors ${
                    draft?.mode === opt.id
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-100'
                      : 'border-slate-600 bg-slate-900/50 text-slate-400 hover:border-slate-500'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </section>

          <section className="grid grid-cols-1 gap-5 md:grid-cols-2">
            <div className="md:col-span-2">
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">Title</label>
              <input
                value={draft?.title ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, title: e.target.value } : d))}
                className={inputClass()}
                disabled={!draft}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Greeting
              </label>
              <input
                value={draft?.greeting ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, greeting: e.target.value } : d))}
                className={inputClass()}
                disabled={!draft}
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Bullet points (one per line)
              </label>
              <textarea
                value={bulletsText}
                onChange={(e) =>
                  setDraft((d) =>
                    d
                      ? {
                          ...d,
                          bullets: e.target.value
                            .split('\n')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }
                      : d,
                  )
                }
                rows={5}
                className={`${inputClass()} min-h-[120px] resize-y font-mono text-xs`}
                disabled={!draft}
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Disclaimer
              </label>
              <textarea
                value={draft?.disclaimer ?? ''}
                onChange={(e) => setDraft((d) => (d ? { ...d, disclaimer: e.target.value } : d))}
                rows={2}
                className={`${inputClass()} resize-y`}
                disabled={!draft}
              />
            </div>
          </section>
        </form>

        {loading ? (
          <section className="rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <p className="text-sm text-slate-400">Loading popup state from backend…</p>
          </section>
        ) : null}

        {previewOpen && draft ? (
          <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
            <button
              type="button"
              className="absolute inset-0 bg-black/75 backdrop-blur-sm"
              aria-label="Close preview"
              onClick={() => setPreviewOpen(false)}
            />
            <div className="relative max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-amber-500/40 bg-[#0f172a] p-6 shadow-2xl ring-2 ring-amber-400/30">
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                className="absolute right-4 top-4 rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
              <p className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400/90">
                Preview · mode: {draft.mode}
              </p>
              <h2 className="mt-2 text-2xl font-bold text-white">{draft.title || 'Untitled'}</h2>
              <p className="mt-3 text-lg font-medium text-amber-200/95">{draft.greeting}</p>
              <ul className="mt-4 list-inside list-disc space-y-2 text-sm text-slate-400">
                {(draft.bullets || []).map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
              <p className="mt-6 border-t border-slate-700 pt-4 text-xs text-slate-500">{draft.disclaimer}</p>
            </div>
          </div>
        ) : null}
      </main>
    </>
  )
}

export default PopupSettingsPage
