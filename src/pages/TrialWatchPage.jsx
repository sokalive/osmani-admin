import { useCallback, useEffect, useMemo, useState } from 'react'
import { Clock, Eye, RefreshCw, ToggleLeft } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import ToggleSwitch from '../components/ToggleSwitch'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getTrialWatchSettings, putTrialWatchSettings, syncStreamUrl } from '../lib/api'

function defaultCfg() {
  return {
    enabled: false,
    trialMinutes: 30,
    previewSeconds: 120,
    previewAfterEnabled: true,
  }
}

function normalize(payload) {
  const b = payload && typeof payload === 'object' ? payload : {}
  return {
    enabled: b.enabled === true || b.trialWatchEnabled === true,
    trialMinutes: Math.max(1, Math.trunc(Number(b.trialMinutes ?? b.trial_watch_minutes) || 30)),
    previewSeconds: Math.max(
      0,
      Math.trunc(Number(b.previewSeconds ?? b.trial_preview_seconds) || 120),
    ),
    previewAfterEnabled:
      b.previewAfterEnabled !== false && b.trial_preview_after_enabled !== false,
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

export default function TrialWatchPage() {
  const { showToast } = useToast()
  const [saved, setSaved] = useState(() => defaultCfg())
  const [draft, setDraft] = useState(() => defaultCfg())
  const [flash, setFlash] = useState(null)

  const load = useCallback(async () => {
    try {
      const data = normalize(await getTrialWatchSettings())
      setSaved(data)
      setDraft(data)
    } catch (e) {
      showToast('error', e?.message || 'Could not load trial settings')
    }
  }, [showToast])

  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(t)
  }, [load])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onChanged = () => void load()
    es.addEventListener('config.trial_watch_changed', onChanged)
    es.addEventListener('trial_watch_settings', onChanged)
    return () => es.close()
  }, [load])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(saved), [draft, saved])

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    try {
      await putTrialWatchSettings(draft)
      await load()
      showFlash('success', 'Trial watch settings saved. Apps receive updates via API/SSE.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-8 pb-10">
          {flash ? (
            <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
          ) : null}

          <header className="space-y-2">
            <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl">Trial Watch</h1>
            <p className="text-sm text-slate-400 sm:text-base">
              Non-premium trial minutes and post-trial preview for installed apps (remote config + secure
              server state per device).
            </p>
          </header>

          <form onSubmit={handleSave} className="flex flex-col gap-6">
            <section className={cardClass()}>
              <div className="flex items-start justify-between gap-4 border-b border-slate-800/70 pb-5">
                <div>
                  <p className="text-base font-semibold text-white">Enable Trial</p>
                  <p className="mt-1 text-sm text-slate-400">
                    When on, non-subscribers can start a one-time server-tracked trial per device fingerprint.
                  </p>
                </div>
                <ToggleSwitch
                  checked={draft.enabled}
                  onChange={(v) => setDraft((d) => ({ ...d, enabled: v }))}
                  aria-label="Enable trial"
                />
              </div>

              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
                <div>
                  <label className={labelClass()}>
                    <Clock className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                    Trial Minutes
                  </label>
                  <input
                    type="number"
                    min={1}
                    max={1440}
                    value={draft.trialMinutes}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        trialMinutes: Math.max(1, Math.trunc(Number(e.target.value) || 1)),
                      }))
                    }
                    className={inputClass()}
                  />
                </div>
                <div>
                  <label className={labelClass()}>
                    <Eye className="mr-1 inline h-3.5 w-3.5" aria-hidden />
                    Preview Seconds After Trial
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={86400}
                    value={draft.previewSeconds}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        previewSeconds: Math.max(0, Math.trunc(Number(e.target.value) || 0)),
                      }))
                    }
                    className={inputClass()}
                  />
                </div>
              </div>

              <div className="mt-5 flex items-start justify-between gap-4 border-t border-slate-800/70 pt-5">
                <div>
                  <p className="text-base font-semibold text-white">Enable Preview After Trial</p>
                  <p className="mt-1 text-sm text-slate-400">
                    Short preview window after trial minutes are used (also tracked server-side).
                  </p>
                </div>
                <ToggleSwitch
                  checked={draft.previewAfterEnabled}
                  onChange={(v) => setDraft((d) => ({ ...d, previewAfterEnabled: v }))}
                  aria-label="Enable preview after trial"
                />
              </div>
            </section>

            <section className={`${cardClass()} text-sm text-slate-400`}>
              <p className="font-semibold text-slate-300">Runtime APIs</p>
              <ul className="mt-2 list-inside list-disc space-y-1">
                <li>
                  <code className="text-amber-200/90">GET /api/runtime/trial-watch</code> — public config
                </li>
                <li>
                  <code className="text-amber-200/90">POST /api/trial-watch/start</code> — bind trial to
                  device + fingerprint
                </li>
                <li>
                  <code className="text-amber-200/90">POST /api/trial-watch/heartbeat</code> — consume
                  trial/preview seconds
                </li>
                <li>
                  SSE events <code className="text-amber-200/90">trial_watch_settings</code> and{' '}
                  <code className="text-amber-200/90">config.trial_watch_changed</code> on sync +
                  subscription-stream
                </li>
              </ul>
            </section>

            <div className="flex flex-col gap-3">
              <button
                type="submit"
                disabled={!dirty}
                className="w-full rounded-2xl bg-gradient-to-r from-[#f5b301] via-amber-400 to-yellow-500 py-4 text-base font-bold text-slate-950 shadow-[0_10px_32px_rgba(245,179,1,0.35)] disabled:opacity-40"
              >
                Save Settings
              </button>
              <button
                type="button"
                onClick={() => setDraft(saved)}
                disabled={!dirty}
                className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-slate-600/80 py-3 text-sm font-medium text-slate-300 disabled:opacity-40"
              >
                <RefreshCw className="h-4 w-4" />
                Reset changes
              </button>
            </div>
          </form>

          <section className={`${cardClass()} flex items-center gap-3 text-sm text-slate-500`}>
            <ToggleLeft className="h-5 w-5 shrink-0 text-[#f5b301]" aria-hidden />
            Subscription stacking renewals add plan duration on top of any remaining active time (never
            shorten expiry).
          </section>
        </div>
      </main>
    </>
  )
}
