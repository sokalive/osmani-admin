import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Download, RefreshCw, Smartphone, Store, Upload } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import AppVersionMigrationCard from '../components/AppVersionMigrationCard'
import ToggleSwitch from '../components/ToggleSwitch'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  getAppUpdateSettings,
  getUpdateCheck,
  postAppUpdateApkUpload,
  postAppUpdateParsePlayStore,
  putAppUpdateSettings,
  syncStreamUrl,
} from '../lib/api'

function defaultCfg() {
  return {
    softUpdate: false,
    forceUpdate: false,
    autoDownload: false,
    source: 'apk',
    apkUrl: '',
    sha256: '',
    playstoreUrl: '',
    updateTitle: '',
    updateMessage: '',
    versionCode: 0,
    versionName: '',
    packageName: '',
    requireUpdateBeforeChannelPlayback: false,
  }
}

function cloneCfg(value) {
  return { ...defaultCfg(), ...(value && typeof value === 'object' ? value : {}) }
}

function isEmptySnapshot(snapshot) {
  const base = defaultCfg()
  return JSON.stringify(cloneCfg(snapshot)) === JSON.stringify(base)
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
    update_title: String(body.update_title ?? '').trim(),
    update_message: String(body.update_message ?? '').trim(),
    version_code: Number(body.version_code) || 0,
    version_name: String(body.version_name ?? '').trim(),
    package_name: String(body.package_name ?? '').trim(),
  }
}

function normalizeSettingsPayload(settings, runtime) {
  const body = settings && typeof settings === 'object' ? settings : {}
  const runtimeBody = normalizeRuntimePayload(runtime)
  const versionCodeRaw = body.versionCode ?? body.version_code ?? runtimeBody.version_code
  const versionCodeNum = Number(versionCodeRaw)
  return {
    softUpdate: body.softUpdate === true,
    forceUpdate: body.forceUpdate === true,
    autoDownload:
      typeof body.autoDownload === 'boolean' ? body.autoDownload : runtimeBody.auto_download,
    source: normalizeRuntimeSource(body.source ?? runtimeBody.source),
    apkUrl: String(body.apkUrl ?? runtimeBody.apk_url ?? '').trim(),
    sha256: String(body.sha256 ?? runtimeBody.apk_sha256 ?? '').trim(),
    playstoreUrl: String(body.playstoreUrl ?? runtimeBody.playstore_url ?? '').trim(),
    updateTitle: String(body.updateTitle ?? body.update_title ?? runtimeBody.update_title ?? '').trim(),
    updateMessage: String(
      body.updateMessage ?? body.update_message ?? runtimeBody.update_message ?? '',
    ).trim(),
    versionCode: Number.isFinite(versionCodeNum) && versionCodeNum > 0 ? Math.trunc(versionCodeNum) : 0,
    versionName: String(body.versionName ?? body.version_name ?? runtimeBody.version_name ?? '').trim(),
    packageName: String(body.packageName ?? body.package_name ?? runtimeBody.package_name ?? '').trim(),
    requireUpdateBeforeChannelPlayback:
      body.requireUpdateBeforeChannelPlayback === true ||
      body.require_update_before_channel_playback === true,
  }
}

function readOnlyInputClass() {
  return `${inputClass()} cursor-not-allowed opacity-90`
}

function isLikelyPlayStoreUrl(value) {
  const s = String(value ?? '').trim()
  if (!s) return false
  if (s.includes('play.google.com')) return true
  return /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/i.test(s)
}

function applyUploadResultToDraft(prev, result) {
  if (!result || typeof result !== 'object') return prev
  return {
    ...prev,
    source: 'apk',
    apkUrl: String(result.apkUrl ?? prev.apkUrl ?? '').trim(),
    sha256: String(result.sha256 ?? prev.sha256 ?? '').trim(),
    versionCode: Number(result.versionCode) || prev.versionCode,
    versionName: String(result.versionName ?? prev.versionName ?? '').trim(),
    packageName: String(result.packageName ?? prev.packageName ?? '').trim(),
    updateTitle: String(result.updateTitle ?? prev.updateTitle ?? '').trim(),
    updateMessage: String(result.updateMessage ?? prev.updateMessage ?? '').trim(),
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
  /** Last server snapshot (load/save/upload refresh) — baseline for “Reset changes”. */
  const [savedSnapshot, setSavedSnapshot] = useState(() => defaultCfg())
  const [draft, setDraft] = useState(() => defaultCfg())
  const [runtime, setRuntime] = useState(() => defaultRuntime())
  const [flash, setFlash] = useState(null)
  const [apkFile, setApkFile] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadError, setUploadError] = useState(null)
  const [versionManualOverride, setVersionManualOverride] = useState(false)
  const [playStoreLoading, setPlayStoreLoading] = useState(false)
  const [playStoreError, setPlayStoreError] = useState(null)
  const playStoreParseRef = useRef(0)
  const apkInputRef = useRef(null)

  function clearApkUploadUi() {
    setApkFile(null)
    setUploading(false)
    setUploadProgress(0)
    setUploadError(null)
    if (apkInputRef.current) apkInputRef.current.value = ''
  }

  function handleResetDraft() {
    setDraft(cloneCfg(savedSnapshot))
    clearApkUploadUi()
    setFlash(null)
  }

  function handleClearForm() {
    setDraft(defaultCfg())
    clearApkUploadUi()
    setFlash(null)
  }

  const load = useCallback(async () => {
    try {
      const [settings, runtimePayload] = await Promise.all([getAppUpdateSettings(), getUpdateCheck()])
      const normalizedRuntime = normalizeRuntimePayload(runtimePayload)
      const merged = cloneCfg(normalizeSettingsPayload(settings, normalizedRuntime))
      setSavedSnapshot(merged)
      setDraft(cloneCfg(merged))
      setRuntime(normalizedRuntime)
      clearApkUploadUi()
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
    es.addEventListener('app_update_settings', onChanged)
    return () => es.close()
  }, [load])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  const fetchPlayStoreMetadata = useCallback(
    async (url) => {
      const trimmed = String(url ?? '').trim()
      if (!isLikelyPlayStoreUrl(trimmed)) return
      const requestId = ++playStoreParseRef.current
      setPlayStoreLoading(true)
      setPlayStoreError(null)
      try {
        const result = await postAppUpdateParsePlayStore(trimmed, { persist: true })
        if (requestId !== playStoreParseRef.current) return
        setDraft((d) => ({
          ...d,
          source: 'play',
          playstoreUrl: String(result.playstoreUrl ?? trimmed).trim(),
          versionName: String(result.versionName ?? d.versionName ?? '').trim(),
          packageName: String(result.packageName ?? result.packageId ?? d.packageName ?? '').trim(),
          versionCode:
            Number(result.versionCode) > 0
              ? Math.trunc(Number(result.versionCode))
              : d.versionCode,
          updateTitle: String(result.updateTitle ?? result.title ?? d.updateTitle ?? '').trim(),
          updateMessage: String(result.updateMessage ?? d.updateMessage ?? '').trim(),
        }))
        await load()
        const codeLabel =
          Number(result.versionCode) > 0 ? ` · code ${result.versionCode}` : ''
        const versionLabel = result.versionName
          ? `v${result.versionName}${codeLabel}`
          : '(version name not listed on Play Store — set version code manually or upload APK)'
        showFlash('success', `Play Store: ${result.title || result.packageId} ${versionLabel}`)
      } catch (err) {
        if (requestId !== playStoreParseRef.current) return
        const message = err?.message || 'Could not fetch Play Store listing'
        setPlayStoreError(message)
        showToast('error', message)
      } finally {
        if (requestId === playStoreParseRef.current) setPlayStoreLoading(false)
      }
    },
    [load, showToast], // showFlash is stable (setState only)
  )

  useEffect(() => {
    const url = draft.playstoreUrl.trim()
    if (!url || url === savedSnapshot.playstoreUrl.trim()) return
    if (!isLikelyPlayStoreUrl(url)) return
    const timer = window.setTimeout(() => {
      void fetchPlayStoreMetadata(url)
    }, 800)
    return () => window.clearTimeout(timer)
  }, [draft.playstoreUrl, savedSnapshot.playstoreUrl, fetchPlayStoreMetadata])

  const refreshPlayStoreListing = useCallback(() => {
    const url = draft.playstoreUrl.trim()
    if (!isLikelyPlayStoreUrl(url)) {
      showToast('error', 'Enter a valid Google Play Store URL first')
      return
    }
    void fetchPlayStoreMetadata(url)
  }, [draft.playstoreUrl, fetchPlayStoreMetadata, showToast])

  const draftDirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(savedSnapshot),
    [draft, savedSnapshot],
  )
  const uploadUiDirty = apkFile !== null || uploading || uploadProgress > 0 || Boolean(uploadError)
  const dirty = draftDirty || uploadUiDirty
  const canClearForm = useMemo(
    () => !isEmptySnapshot(draft) || uploadUiDirty || !isEmptySnapshot(savedSnapshot),
    [draft, uploadUiDirty, savedSnapshot],
  )

  const previewMode = useMemo(() => previewModeLabel(draft), [draft])
  const previewSource = useMemo(() => previewSourceLabel(draft.source), [draft.source])
  const previewAuto = useMemo(() => (draft.autoDownload ? 'Enabled' : 'Disabled'), [draft.autoDownload])
  const previewVersion = useMemo(() => {
    const code = Number(draft.versionCode) || 0
    const name = String(draft.versionName || '').trim()
    if (code > 0 && name) return `${name} (${code})`
    if (code > 0) return String(code)
    return '—'
  }, [draft.versionCode, draft.versionName])

  async function handleSave(e) {
    e.preventDefault()
    try {
      const payload = {
        softUpdate: draft.softUpdate === true,
        forceUpdate: draft.forceUpdate === true,
        autoDownload: draft.autoDownload === true,
        requireUpdateBeforeChannelPlayback: draft.requireUpdateBeforeChannelPlayback === true,
        source: draft.source,
        apkUrl: draft.apkUrl.trim(),
        sha256: draft.sha256.trim(),
        playstoreUrl: draft.playstoreUrl.trim(),
        updateTitle: draft.updateTitle.trim(),
        updateMessage: draft.updateMessage.trim(),
        versionCode: Number(draft.versionCode) || 0,
        versionName: draft.versionName.trim(),
        packageName: draft.packageName.trim(),
      }
      console.info('[AppUpdatePage] save payload:', payload)
      await putAppUpdateSettings(payload)
      await load()
      showFlash('success', 'App update configuration saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  function handleChooseApk() {
    apkInputRef.current?.click()
  }

  function handleApkFileChange(e) {
    const file = e.target.files?.[0] ?? null
    setApkFile(file)
    setUploadError(null)
    e.target.value = ''
  }

  async function handleUploadApk() {
    if (!apkFile) {
      showToast('error', 'Choose an APK file first')
      return
    }
    setUploading(true)
    setUploadProgress(0)
    setUploadError(null)
    try {
      const result = await postAppUpdateApkUpload(apkFile, {
        onProgress: (pct) => setUploadProgress(pct),
      })
      setUploadProgress(100)
      setVersionManualOverride(false)
      setDraft((d) => applyUploadResultToDraft(d, result))
      await load()
      showFlash(
        'success',
        `APK v${result?.versionName ?? result?.versionCode ?? ''} uploaded — version, hash, and URL saved automatically.`,
      )
    } catch (err) {
      const message = err?.message || 'APK upload failed'
      setUploadError(message)
      showToast('error', message)
    } finally {
      setUploading(false)
      setApkFile(null)
      if (apkInputRef.current) apkInputRef.current.value = ''
      window.setTimeout(() => setUploadProgress(0), 1200)
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
                <ModeToggleRow
                  title="Require Update Before Watching Channels"
                  description="Block channel playback for v16–v23 until they update to v24 (v24 users are not affected)"
                  checked={draft.requireUpdateBeforeChannelPlayback}
                  onChange={(v) =>
                    setDraft((d) => ({ ...d, requireUpdateBeforeChannelPlayback: v }))
                  }
                />
              </div>
            </section>

            <AppVersionMigrationCard />

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
                <h2 className="text-lg font-bold text-white">Update copy</h2>
                <p className="mt-1 text-sm text-slate-500">Title and message shown in the client update UI</p>
              </div>

              <div>
                <label className={labelClass()}>Update Title</label>
                <input
                  value={draft.updateTitle}
                  onChange={(e) => setDraft((d) => ({ ...d, updateTitle: e.target.value }))}
                  className={inputClass()}
                  placeholder="New version available"
                />
              </div>

              <div>
                <label className={labelClass()}>Update Message</label>
                <textarea
                  value={draft.updateMessage}
                  onChange={(e) => setDraft((d) => ({ ...d, updateMessage: e.target.value }))}
                  rows={3}
                  className={`${inputClass()} min-h-[88px] resize-y`}
                  placeholder="Please update to continue with the latest features and fixes."
                />
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-slate-500">
                  Version fields are filled from APK upload or Play Store URL
                </p>
                <button
                  type="button"
                  onClick={() => setVersionManualOverride((v) => !v)}
                  className="text-xs font-semibold text-[#f5c842] hover:text-[#f5b301]"
                >
                  {versionManualOverride ? 'Lock to auto-detected' : 'Edit version manually'}
                </button>
              </div>

              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelClass()}>Version Code</label>
                  <input
                    type="number"
                    min={0}
                    readOnly={!versionManualOverride}
                    value={draft.versionCode || ''}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        versionCode: Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                      }))
                    }
                    className={versionManualOverride ? inputClass() : readOnlyInputClass()}
                    placeholder="Auto from APK"
                  />
                  <p className="mt-1.5 text-xs text-slate-500">
                    Latest saved: {savedSnapshot.versionCode || 0}
                    {draft.versionCode > 0 ? ` · draft: ${draft.versionCode}` : ''}
                  </p>
                </div>
                <div>
                  <label className={labelClass()}>Version Name</label>
                  <input
                    readOnly={!versionManualOverride}
                    value={draft.versionName}
                    onChange={(e) => setDraft((d) => ({ ...d, versionName: e.target.value }))}
                    className={versionManualOverride ? inputClass() : readOnlyInputClass()}
                    placeholder="Auto from APK or Play Store"
                  />
                </div>
              </div>

              <div>
                <label className={labelClass()}>Package Name</label>
                <input
                  readOnly={!versionManualOverride}
                  value={draft.packageName}
                  onChange={(e) => setDraft((d) => ({ ...d, packageName: e.target.value }))}
                  className={`${versionManualOverride ? inputClass() : readOnlyInputClass()} font-mono text-xs`}
                  placeholder="com.example.app"
                />
              </div>
            </section>

            <section className={`${cardClass()} space-y-5`}>
              <div>
                <h2 className="text-lg font-bold text-white">APK upload</h2>
                <p className="mt-1 text-sm text-slate-500">
                  Upload a release APK — URL and SHA-256 are saved automatically
                </p>
              </div>

              <input
                ref={apkInputRef}
                type="file"
                accept=".apk,application/vnd.android.package-archive"
                className="hidden"
                onChange={handleApkFileChange}
              />

              <div className="rounded-2xl border-2 border-dashed border-slate-600/80 bg-[#0a0e16] p-6 text-center">
                <Upload className="mx-auto h-10 w-10 text-[#f5b301]/80" aria-hidden />
                <p className="mt-3 text-sm font-medium text-slate-200">
                  {apkFile ? apkFile.name : 'No file selected'}
                </p>
                <p className="mt-1 text-xs text-slate-500">Android package (.apk) only</p>
                <div className="mt-5 flex flex-col gap-2 sm:flex-row sm:justify-center">
                  <button
                    type="button"
                    onClick={handleChooseApk}
                    disabled={uploading}
                    className="rounded-xl border border-[#f5b301]/50 bg-[#f5b301]/10 px-5 py-2.5 text-sm font-semibold text-[#f5c842] hover:bg-[#f5b301]/20 disabled:opacity-50"
                  >
                    Choose APK
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleUploadApk()}
                    disabled={!apkFile || uploading}
                    className="rounded-xl bg-gradient-to-r from-[#f5b301] to-yellow-500 px-5 py-2.5 text-sm font-bold text-slate-950 disabled:opacity-50"
                  >
                    {uploading ? 'Uploading…' : 'Upload APK'}
                  </button>
                </div>
                {uploadError ? (
                  <p className="mt-4 text-sm text-red-400" role="alert">
                    {uploadError}
                  </p>
                ) : null}
                {uploading || uploadProgress > 0 ? (
                  <div className="mt-5">
                    <div className="mb-1 flex justify-between text-xs text-slate-400">
                      <span>Upload progress</span>
                      <span>{uploadProgress}%</span>
                    </div>
                    <div className="h-2 overflow-hidden rounded-full bg-slate-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-[#f5b301] to-yellow-500 transition-all duration-200"
                        style={{ width: `${uploadProgress}%` }}
                      />
                    </div>
                  </div>
                ) : null}
              </div>

              <div>
                <label className={labelClass()}>APK URL</label>
                <input
                  readOnly
                  value={draft.apkUrl}
                  className={readOnlyInputClass()}
                  placeholder="Upload an APK to generate the URL"
                />
                <p className="mt-1.5 text-xs text-slate-500">Set automatically after upload</p>
              </div>

              <div>
                <label className={labelClass()}>APK SHA-256 Hash</label>
                <textarea
                  readOnly
                  value={draft.sha256}
                  rows={2}
                  className={`${readOnlyInputClass()} min-h-[72px] resize-none font-mono text-xs`}
                  placeholder="Computed on upload"
                />
                <p className="mt-2 text-xs leading-relaxed text-slate-500">
                  Leave empty to skip verification on the client
                </p>
              </div>

              <div>
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                  <label className={labelClass()}>Play Store URL</label>
                  <button
                    type="button"
                    onClick={refreshPlayStoreListing}
                    disabled={playStoreLoading || !isLikelyPlayStoreUrl(draft.playstoreUrl.trim())}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#f5c842] hover:text-[#f5b301] disabled:opacity-40"
                  >
                    <RefreshCw className={`h-3.5 w-3.5 ${playStoreLoading ? 'animate-spin' : ''}`} aria-hidden />
                    Refresh listing
                  </button>
                </div>
                <input
                  value={draft.playstoreUrl}
                  onChange={(e) => {
                    setPlayStoreError(null)
                    setDraft((d) => ({ ...d, playstoreUrl: e.target.value }))
                  }}
                  onBlur={(e) => {
                    const url = e.target.value.trim()
                    if (url && isLikelyPlayStoreUrl(url)) {
                      void fetchPlayStoreMetadata(url)
                    }
                  }}
                  className={inputClass()}
                  placeholder="https://play.google.com/store/apps/details?id=..."
                />
                <p className="mt-1.5 text-xs text-slate-500">
                  Paste or refresh a Play Store link to auto-fill title, package id, and version name.
                  Version code is not published on Play Store — use Edit version manually or APK upload.
                </p>
                {playStoreLoading ? (
                  <p className="mt-2 text-xs text-[#f5c842]">Fetching Play Store listing…</p>
                ) : null}
                {playStoreError ? (
                  <p className="mt-2 text-xs text-red-400" role="alert">
                    {playStoreError}
                  </p>
                ) : null}
              </div>
            </section>

            <div className="flex flex-col gap-3">
              <button
                type="submit"
                disabled={!draftDirty}
                className="w-full rounded-2xl bg-gradient-to-r from-[#f5b301] via-amber-400 to-yellow-500 py-4 text-base font-bold text-slate-950 shadow-[0_10px_32px_rgba(245,179,1,0.35)] transition-transform enabled:hover:brightness-105 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Save Settings
              </button>
              <button
                type="button"
                onClick={handleResetDraft}
                disabled={!dirty}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-600/80 py-3 text-sm font-medium text-slate-300 transition-colors hover:border-slate-500 hover:bg-slate-800/50 disabled:opacity-40"
              >
                <RefreshCw className="h-4 w-4" />
                Reset changes
              </button>
              <button
                type="button"
                onClick={handleClearForm}
                disabled={!canClearForm}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-700/80 py-3 text-sm font-medium text-slate-400 transition-colors hover:border-slate-600 hover:bg-slate-800/40 hover:text-slate-200 disabled:opacity-40"
              >
                Clear form
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
              <PreviewRow label="Version" value={previewVersion} />
            </section>

            <section className={`${cardClass()} space-y-4`}>
              <div>
                <h2 className="text-sm font-semibold uppercase tracking-wide text-slate-400">
                  Canonical Runtime Payload
                </h2>
                <p className="mt-1 text-sm text-slate-500">
                  Mirrors live{' '}
                  <code className="text-slate-400">GET /api/update-check</code> and{' '}
                  <code className="text-slate-400">GET /api/runtime/app-update</code>; SSE event{' '}
                  <code className="text-slate-400">app_update_settings</code> on subscription-stream.
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
                <RuntimeField label="update_title" value={runtime.update_title || '—'} />
                <RuntimeField label="update_message" value={runtime.update_message || '—'} wide />
                <RuntimeField label="version_code" value={String(runtime.version_code || 0)} />
                <RuntimeField label="version_name" value={runtime.version_name || '—'} />
                <RuntimeField label="package_name" value={runtime.package_name || '—'} wide />
              </div>
            </section>
          </form>
        </div>
      </main>
    </>
  )
}

export default AppUpdatePage
