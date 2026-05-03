import { useCallback, useEffect, useMemo, useState } from 'react'
import { Eye, X } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getPopupSettings, putPopupSettings } from '../lib/api'

function defaultPopup() {
  return {
    mode: 'once',
    title: 'Welcome to Osmani TV',
    greeting: 'Hello!',
    introduction: 'Discover live sports, movies, and family channels in one place.',
    bullets: ['HD streams where available', 'Manage subscriptions anytime', 'Support via WhatsApp'],
    disclaimer: 'Content availability may vary by region.',
  }
}

function mergePopup(p) {
  const d = { ...defaultPopup(), ...p }
  if (!Array.isArray(d.bullets) || d.bullets.length === 0) d.bullets = defaultPopup().bullets
  return d
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function PopupSettingsPage() {
  const { showToast } = useToast()
  const [saved, setSaved] = useState(() => mergePopup(defaultPopup()))
  const [draft, setDraft] = useState(() => mergePopup(defaultPopup()))
  const [previewOpen, setPreviewOpen] = useState(false)
  const [flash, setFlash] = useState(null)

  const load = useCallback(async () => {
    try {
      const s = await getPopupSettings()
      const merged = mergePopup({ ...defaultPopup(), ...s })
      setSaved(merged)
      setDraft(merged)
    } catch (e) {
      showToast('error', e?.message || 'Could not load popup settings')
    }
  }, [showToast])

  useEffect(() => {
    load()
  }, [load])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    if (!draft.title.trim()) {
      showFlash('error', 'Title is required.')
      return
    }
    try {
      const next = mergePopup(draft)
      const stored = await putPopupSettings(next)
      const merged = mergePopup(stored)
      setSaved(merged)
      setDraft(merged)
      showFlash('success', 'Popup settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  const bulletsText = Array.isArray(draft.bullets) ? draft.bullets.join('\n') : ''

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
                  onClick={() => setDraft((d) => ({ ...d, mode: opt.id }))}
                  className={`rounded-xl border px-5 py-3 text-sm font-semibold transition-colors ${
                    draft.mode === opt.id
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
                value={draft.title}
                onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                className={inputClass()}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Greeting
              </label>
              <input
                value={draft.greeting}
                onChange={(e) => setDraft((d) => ({ ...d, greeting: e.target.value }))}
                className={inputClass()}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Introduction
              </label>
              <textarea
                value={draft.introduction}
                onChange={(e) => setDraft((d) => ({ ...d, introduction: e.target.value }))}
                rows={3}
                className={`${inputClass()} min-h-[88px] resize-y`}
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Bullet points (one per line)
              </label>
              <textarea
                value={bulletsText}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    bullets: e.target.value
                      .split('\n')
                      .map((s) => s.trim())
                      .filter(Boolean),
                  }))
                }
                rows={5}
                className={`${inputClass()} min-h-[120px] resize-y font-mono text-xs`}
              />
            </div>
            <div className="md:col-span-2">
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Disclaimer
              </label>
              <textarea
                value={draft.disclaimer}
                onChange={(e) => setDraft((d) => ({ ...d, disclaimer: e.target.value }))}
                rows={2}
                className={`${inputClass()} resize-y`}
              />
            </div>
          </section>
        </form>

        {previewOpen ? (
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
              <p className="mt-3 text-sm leading-relaxed text-slate-300">{draft.introduction}</p>
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
