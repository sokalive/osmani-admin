import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import ToggleSwitch from '../components/ToggleSwitch'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getAppUpdateSettings, getUpdateCheck, putAppUpdateSettings, syncStreamUrl } from '../lib/api'

function defaultCfg() {
  return {
    softUpdate: false,
    forceUpdate: false,
    autoDownload: false,
    source: 'apk',
    apkUrl: '',
    sha256: '',
    playstoreUrl: '',
  }
}

function defaultRuntime() {
  return {
    decision: 'NONE',
    source: 'apk',
    apk_url: '',
    apk_sha256: '',
    playstore_url: '',
    auto_download: false,
    server_time: '',
    notice: '',
  }
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function normalizeRuntimeSource(value) {
  return String(value ?? '').trim().toLowerCase() === 'play' ? 'play' : 'apk'
}

function normalizeRuntimePayload(payload) {
  const body = payload && typeof payload === 'object' ? payload : {}
  return {
    decision: ['SOFT', 'FORCE'].includes(String(body.decision ?? '').toUpperCase())
      ? String(body.decision).toUpperCase()
      : 'NONE',
    source: normalizeRuntimeSource(body.source),
    apk_url: String(body.apk_url ?? '').trim(),
    apk_sha256: String(body.apk_sha256 ?? '').trim(),
    playstore_url: String(body.playstore_url ?? '').trim(),
    auto_download: body.auto_download === true,
    server_time: String(body.server_time ?? '').trim(),
    notice: String(body.notice ?? '').trim(),
  }
}

function normalizeSettingsPayload(settings, runtime) {
  const body = settings && typeof settings === 'object' ? settings : {}
  const runtimeBody = normalizeRuntimePayload(runtime)
  return {
    softUpdate: body.softUpdate === true,
    forceUpdate: body.forceUpdate === true,
    autoDownload:
      typeof body.autoDownload === 'boolean' ? body.autoDownload : runtimeBody.auto_download,
    source: normalizeRuntimeSource(body.source ?? runtimeBody.source),
    apkUrl: String(body.apkUrl ?? runtimeBody.apk_url ?? '').trim(),
    sha256: String(body.sha256 ?? runtimeBody.apk_sha256 ?? '').trim(),
    playstoreUrl: String(body.playstoreUrl ?? runtimeBody.playstore_url ?? '').trim(),
  }
}

function runtimeTimeLabel(value) {
  if (!value) return 'Not available'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString()
}

function AppUpdatePage() {
  const { showToast } = useToast()
  const [cfg, setCfg] = useState(() => defaultCfg())
  const [draft, setDraft] = useState(() => ({ ...defaultCfg() }))
  const [runtime, setRuntime] = useState(() => defaultRuntime())
  const [flash, setFlash] = useState(null)

  const load = useCallback(async () => {
    try {
      const [settings, runtimePayload] = await Promise.all([getAppUpdateSettings(), getUpdateCheck()])
      const normalizedRuntime = normalizeRuntimePayload(runtimePayload)
      const merged = { ...defaultCfg(), ...normalizeSettingsPayload(settings, normalizedRuntime) }
      setCfg(merged)
      setDraft(merged)
      setRuntime(normalizedRuntime)
    } catch (e) {
      showToast('error', e?.message || 'Could not load app update settings')
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
    es.addEventListener('config.app_update_changed', onChanged)
    return () => es.close()
  }, [load])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(cfg), [draft, cfg])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    try {
      const payload = {
        softUpdate: draft.softUpdate === true,
        forceUpdate: draft.forceUpdate === true,
        autoDownload: draft.autoDownload === true,
        source: draft.source,
        apkUrl: draft.apkUrl.trim(),
        sha256: draft.sha256.trim(),
        playstoreUrl: draft.playstoreUrl.trim(),
      }
      console.info('[AppUpdatePage] save payload:', payload)
      await putAppUpdateSettings(payload)
      await load()
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
                  onClick={() => setDraft((d) => ({ ...d, source: 'apk' }))}
                  className={`flex flex-1 items-center justify-center gap-2 rounded-xl border px-4 py-3 text-sm font-medium transition-colors ${
                    draft.source === 'apk'
                      ? 'border-amber-500/60 bg-amber-500/15 text-amber-100'
                      : 'border-slate-600 bg-slate-900/50 text-slate-400'
                  }`}
                >
                  <Download className="h-4 w-4" />
                  APK
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
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-semibold uppercase text-slate-400">
                Play Store URL
              </label>
              <input
                value={draft.playstoreUrl}
                onChange={(e) => setDraft((d) => ({ ...d, playstoreUrl: e.target.value }))}
                className={inputClass()}
                placeholder="https://play.google.com/store/apps/details?id=..."
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
              <p className="text-[11px] font-semibold uppercase text-slate-500">Save payload</p>
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
                <li className="truncate font-mono text-[11px] text-amber-200/90">
                  apkUrl: {draft.apkUrl || '—'}
                </li>
                <li className="truncate font-mono text-[11px] text-amber-200/90">
                  playstoreUrl: {draft.playstoreUrl || '—'}
                </li>
              </ul>
            </div>
          </section>

          <section className="space-y-4 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04] lg:col-span-2">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-emerald-400/90">
              Canonical Runtime Payload
            </h2>
            <p className="text-sm text-slate-400">
              This mirrors the live `GET /api/update-check` contract consumed by runtime clients.
            </p>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  decision
                </p>
                <p className="mt-1 text-sm text-emerald-200">{runtime.decision}</p>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  source
                </p>
                <p className="mt-1 text-sm text-emerald-200">{runtime.source}</p>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  auto_download
                </p>
                <p className="mt-1 text-sm text-emerald-200">
                  {runtime.auto_download ? 'true' : 'false'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  server_time
                </p>
                <p className="mt-1 text-sm text-emerald-200">{runtimeTimeLabel(runtime.server_time)}</p>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3 md:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  apk_url
                </p>
                <p className="mt-1 break-all font-mono text-xs text-emerald-200/95">
                  {runtime.apk_url || '—'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3 md:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  playstore_url
                </p>
                <p className="mt-1 break-all font-mono text-xs text-emerald-200/95">
                  {runtime.playstore_url || '—'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3 md:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  apk_sha256
                </p>
                <p className="mt-1 break-all font-mono text-xs text-emerald-200/95">
                  {runtime.apk_sha256 || '—'}
                </p>
              </div>
              <div className="rounded-xl border border-slate-700/80 bg-slate-900/60 px-4 py-3 md:col-span-2">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  notice
                </p>
                <p className="mt-1 text-sm text-emerald-200">{runtime.notice || '—'}</p>
              </div>
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
