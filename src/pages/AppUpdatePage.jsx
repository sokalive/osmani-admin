import { useCallback, useEffect, useMemo, useState } from 'react'
import { Download, RefreshCw, Smartphone, Store } from 'lucide-react'
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
  return 'w-full rounded-xl border border-slate-600/60 bg-[#0a0e16] px-4 py-3 text-sm text-slate-100 placeholder:text-slate-500 focus:border-[#f5b301]/50 focus:outline-none focus:ring-2 focus:ring-[#f5b301]/20'
}

function labelClass() {
  return 'mb-2 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function cardClass() {
  return 'rounded-2xl border border-slate-700/50 bg-[#0b0f17] p-5 shadow-[0_12px_40px_rgba(0,0,0,0.35)] ring-1 ring-white/[0.04] sm:p-6'
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

function previewModeLabel(draft) {
  if (draft.forceUpdate) return 'Force Update'
  if (draft.softUpdate) return 'Soft Update'
  return 'None'
}

function previewSourceLabel(source) {
  return source === 'play' ? 'Google Play Store' : 'In-App APK Update'
}

function ModeToggleRow({ title, description, checked, onChange }) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-slate-800/70 py-5 last:border-b-0 last:pb-0 first:pt-0">
      <div className="min-w-0 flex-1 pr-2">
        <p className="text-base font-semibold text-white">{title}</p>
        <p className="mt-1.5 text-sm leading-relaxed text-slate-400">{description}</p>
      </div>
      <ToggleSwitch checked={checked} onChange={onChange} aria-label={title} />
    </div>
  )
}

function PreviewRow({ label, value }) {
  return (
    <div className="flex items-center justify-between gap-4 border-b border-slate-800/60 py-3 last:border-b-0">
      <span className="text-sm text-slate-400">{label}</span>
      <span className="text-right text-sm font-semibold text-[#f5c842]">{value}</span>
    </div>
  )
}

function RuntimeField({ label, value, wide = false }) {
  return (
    <div
      className={`rounded-xl border border-slate-700/60 bg-[#0a0e16] px-4 py-3 ${wide ? 'sm:col-span-2' : ''}`}
    >
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 break-all text-sm font-medium text-emerald-300/95">{value}</p>
    </div>
  )
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

  const previewMode = useMemo(() => previewModeLabel(draft), [draft])
  const previewSource = useMemo(() => previewSourceLabel(draft.source), [draft.source])
  const previewAuto = useMemo(() => (draft.autoDownload ? 'Enabled' : 'Disabled'), [draft.autoDownload])

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
      <main className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-2xl flex flex-col gap-8 pb-10">
          {flash ? (
            <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
          ) : null}

          <header className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">App Update Control</h1>
            <p className="text-sm text-slate-400 sm:text-base">Manage how users receive app updates</p>
          </header>

          <form onSubmit={handleSave} className="flex flex-col gap-6">
            <section className={cardClass()}>
              <h2 className="mb-1 text-lg font-bold text-white">Update Mode</h2>
              <p className="mb-4 text-sm text-slate-500">Choose how updates are presented to users</p>
              <div>
                <ModeToggleRow
                  title="Soft Update"
                  description="Users see an update popup every 5 minutes but can continue using the app"
                  checked={draft.softUpdate}
                  onChange={(v) => setDraft((d) => ({ ...d, softUpdate: v }))}
                />
                <ModeToggleRow
                  title="Force Update"
                  description="Lock the entire app until the user updates"
                  checked={draft.forceUpdate}
                  onChange={(v) => setDraft((d) => ({ ...d, forceUpdate: v }))}
                />
                <ModeToggleRow
                  title="Auto Download"
                  description="Automatically download the APK in the background"
                  checked={draft.autoDownload}
                  onChange={(v) => setDraft((d) => ({ ...d, autoDownload: v }))}
                />
              </div>
            </section>

            <section className={cardClass()}>
              <h2 className="mb-1 text-lg font-bold text-white">Update Source</h2>
              <p className="mb-5 text-sm text-slate-500">Where users download the update from</p>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, source: 'apk' }))}
                  className={`flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-2xl border-2 px-4 py-5 text-center transition-all ${
                    draft.source === 'apk'
                      ? 'border-[#f5b301]/70 bg-[#f5b301]/10 text-[#f5c842] shadow-[0_0_24px_rgba(245,179,1,0.12)]'
                      : 'border-slate-700/80 bg-[#0a0e16] text-slate-400 hover:border-slate-600 hover:text-slate-200'
                  }`}
                >
                  <Download
                    className={`h-7 w-7 ${draft.source === 'apk' ? 'text-[#f5b301]' : 'text-slate-500'}`}
                  />
                  <span className="text-sm font-semibold leading-snug">In-App APK Update</span>
                </button>
                <button
                  type="button"
                  onClick={() => setDraft((d) => ({ ...d, source: 'play' }))}
                  className={`flex min-h-[88px] flex-col items-center justify-center gap-2 rounded-2xl border-2 px-4 py-5 text-center transition-all ${
                    draft.source === 'play'
                      ? 'border-[#f5b301]/70 bg-[#f5b301]/10 text-[#f5c842] shadow-[0_0_24px_rgba(245,179,1,0.12)]'
                      : 'border-slate-700/80 bg-[#0a0e16] text-slate-400 hover:border-slate-600 hover:text-slate-200'
                  }`}
                >
                  <Store
                    className={`h-7 w-7 ${draft.source === 'play' ? 'text-[#f5b301]' : 'text-slate-500'}`}
                  />
                  <span className="text-sm font-semibold leading-snug">Google Play Store</span>
                </button>
              </div>
            </section>

            <section className={`${cardClass()} space-y-5`}>
              <div>
                <h2 className="text-lg font-bold text-white">Package details</h2>
                <p className="mt-1 text-sm text-slate-500">URLs and integrity checks for the update package</p>
              </div>

              <div>
                <label className={labelClass()}>APK URL</label>
                <input
                  value={draft.apkUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, apkUrl: e.target.value }))}
                  className={inputClass()}
                  placeholder="https://example.com/app-release.apk"
                />
              </div>

              <div>
                <label className={labelClass()}>Play Store URL</label>
                <input
                  value={draft.playstoreUrl}
                  onChange={(e) => setDraft((d) => ({ ...d, playstoreUrl: e.target.value }))}
                  className={inputClass()}
                  placeholder="https://play.google.com/store/apps/details?id=..."
                />
              </div>

              <div>
                <label className={labelClass()}>APK SHA-256 Hash</label>
                <textarea
                  value={draft.sha256}
                  onChange={(e) => setDraft((d) => ({ ...d, sha256: e.target.value }))}
                  rows={3}
                  placeholder="64-character hex checksum"
                  className={`${inputClass()} min-h-[96px] resize-y font-mono text-xs`}
                />
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  Leave empty to skip verification…
                </p>
              </div>
            </section>

            <div className="flex flex-col gap-3">
              <button
                type="submit"
                disabled={!dirty}
                className="w-full rounded-2xl bg-gradient-to-r from-[#f5b301] via-amber-400 to-yellow-500 py-4 text-base font-bold text-slate-950 shadow-[0_10px_32px_rgba(245,179,1,0.35)] transition-transform enabled:hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save Settings
              </button>
              <button
                type="button"
                onClick={() => setDraft({ ...cfg })}
                disabled={!dirty}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-600/80 py-3 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-800/50 disabled:opacity-40"
              >
                <RefreshCw className="h-4 w-4" />
                Reset changes
              </button>
            </div>

            <section className={cardClass()}>
              <div className="mb-4 flex items-center gap-2">
                <Smartphone className="h-5 w-5 text-[#f5b301]" aria-hidden />
                <h2 className="text-lg font-bold text-white">Preview</h2>
              </div>
              <p className="mb-4 text-sm text-slate-500">Summary of current draft settings</p>
              <PreviewRow label="Mode" value={previewMode} />
              <PreviewRow label="Source" value={previewSource} />
              <PreviewRow label="Auto Download" value={previewAuto} />
            </section>

            <section className={`${cardClass()} space-y-4`}>
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Canonical Runtime Payload
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Mirrors live <code className="text-slate-400">GET /api/update-check</code> for runtime clients.
                </p>
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <RuntimeField label="decision" value={runtime.decision} />
                <RuntimeField label="source" value={runtime.source} />
                <RuntimeField label="auto_download" value={runtime.auto_download ? 'true' : 'false'} />
                <RuntimeField label="server_time" value={runtimeTimeLabel(runtime.server_time)} />
                <RuntimeField label="apk_url" value={runtime.apk_url || '—'} wide />
                <RuntimeField label="playstore_url" value={runtime.playstore_url || '—'} wide />
                <RuntimeField label="apk_sha256" value={runtime.apk_sha256 || '—'} wide />
                <RuntimeField label="notice" value={runtime.notice || '—'} wide />
              </div>
            </section>
          </form>
        </div>
      </main>
    </>
  )
}

export default AppUpdatePage
