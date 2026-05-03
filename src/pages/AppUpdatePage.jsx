import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import ToggleSwitch from '../components/ToggleSwitch'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getAppUpdateSettings, putAppUpdateSettings } from '../lib/api'

function defaultCfg() {
  return {
    softUpdate: true,
    forceUpdate: false,
    autoDownload: true,
    source: 'inapp',
    apkUrl: 'https://cdn.osmani.tv/releases/osmani-latest.apk',
    sha256: '',
  }
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function AppUpdatePage() {
  const { showToast } = useToast()
  const [cfg, setCfg] = useState(() => defaultCfg())
  const [draft, setDraft] = useState(() => ({ ...defaultCfg() }))
  const [flash, setFlash] = useState(null)

  const load = useCallback(async () => {
    try {
      const s = await getAppUpdateSettings()
      const merged = { ...defaultCfg(), ...s }
      setCfg(merged)
      setDraft(merged)
    } catch (e) {
      showToast('error', e?.message || 'Could not load app update settings')
    }
  }, [showToast])

  useEffect(() => {
    load()
  }, [load])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(cfg), [draft, cfg])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    try {
      const saved = await putAppUpdateSettings(draft)
      setCfg(saved)
      setDraft(saved)
      showFlash('success', 'App update configuration saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">App Update</h1>
          <p className="mt-1 text-sm text-slate-400">Rollout policy and package source</p>
        </header>

        <form onSubmit={handleSave} className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">
              Update modes
            </h2>
            <div className="flex items-center justify-between rounded-xl border border-slate-600/50 bg-slate-900/40 px-4 py-3">
              <span className="text-sm text-slate-300">Soft update</span>
              <ToggleSwitch
                checked={draft.softUpdate}
                onChange={(v) => setDraft((d) => ({ ...d, softUpdate: v }))}
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-slate-600/50 bg-slate-900/40 px-4 py-3">
              <span className="text-sm text-slate-300">Force update</span>
              <ToggleSwitch
                checked={draft.forceUpdate}
                onChange={(v) => setDraft((d) => ({ ...d, forceUpdate: v }))}
              />
            </div>
            <div className="flex items-center justify-between rounded-xl border border-slate-600/50 bg-slate-900/40 px-4 py-3">
              <span className="text-sm text-slate-300">Auto download</span>
              <ToggleSwitch
                checked={draft.autoDownload}
                onChange={(v) => setDraft((d) => ({ ...d, autoDownload: v }))}
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Source
              </label>
              <div className="flex gap-3">
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, source: 'inapp' }))}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                    draft.source === 'inapp'
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-100'
                      : 'border-slate-600 bg-slate-900/50 text-slate-400'
                  }`}
                >
                  <Download className="h-4 w-4" />
                  In-App APK
                </button>
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, source: 'play' }))}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                    draft.source === 'play'
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-100'
                      : 'border-slate-600 bg-slate-900/50 text-slate-400'
                  }`}
                >
                  Google Play
                </button>
              </div>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">
              Package
            </h2>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                APK URL
              </label>
              <input
                value={draft.apkUrl}
                onChange={(e) => setDraft((d) => ({ ...d, apkUrl: e.target.value }))}
                className={inputClass()}
                disabled={draft.source === 'play'}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                SHA-256 hash
              </label>
              <textarea
                value={draft.sha256}
                onChange={(e) => setDraft((d) => ({ ...d, sha256: e.target.value }))}
                rows={3}
                placeholder="64-character hex checksum"
                className={`${inputClass()} min-h-[88px] resize-y font-mono text-xs`}
              />
            </div>

            <div className="rounded-xl border border-dashed border-slate-600 bg-slate-900/50 p-4">
              <p className="text-[11px] font-semibold uppercase text-slate-500">Preview</p>
              <ul className="mt-2 space-y-1 text-xs text-slate-400">
                <li>
                  Soft: <span className="text-slate-200">{draft.softUpdate ? 'on' : 'off'}</span>
                </li>
                <li>
                  Force: <span className="text-slate-200">{draft.forceUpdate ? 'on' : 'off'}</span>
                </li>
                <li>
                  Auto DL: <span className="text-slate-200">{draft.autoDownload ? 'on' : 'off'}</span>
                </li>
                <li>
                  Source: <span className="text-slate-200">{draft.source}</span>
                </li>
                <li className="truncate font-mono text-[11px] text-amber-200/90">{draft.apkUrl}</li>
              </ul>
            </div>
          </section>

          <div className="flex flex-wrap justify-end gap-3 lg:col-span-2">
            <button
              type="button"
              onClick={() => setDraft({ ...cfg })}
              disabled={!dirty}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-600 px-6 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              <RefreshCw className="h-4 w-4" />
              Reset
            </button>
            <button
              type="submit"
              disabled={!dirty}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-8 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:opacity-40"
            >
              Save settings
            </button>
          </div>
        </form>
      </main>
    </>
  )
}

export default AppUpdatePage
