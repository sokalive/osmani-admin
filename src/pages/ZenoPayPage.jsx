import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Wifi, XCircle } from 'lucide-react'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getZenopaySettings, postZenopayTest, putZenopaySettings } from '../lib/api'

function defaultSettings() {
  return {
    environment: 'test',
    apiEndpoint: '',
    accountId: '',
    apiKey: '',
    webhookUrl: '',
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: '',
  }
}

function maskKey(key) {
  if (!key || key.length < 8) return '••••••••'
  return `${key.slice(0, 4)}${'•'.repeat(Math.min(16, key.length - 8))}${key.slice(-4)}`
}

function inputClass() {
  return 'w-full rounded-xl border border-slate-600/70 bg-slate-900/80 px-3 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:border-amber-500/60 focus:outline-none focus:ring-2 focus:ring-amber-500/25'
}

function labelClass() {
  return 'mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-400'
}

function ZenoPayPage() {
  const { showToast } = useToast()
  const [cfg, setCfg] = useState(() => defaultSettings())
  const [draft, setDraft] = useState(() => ({ ...defaultSettings() }))
  const [testing, setTesting] = useState(false)
  const [flash, setFlash] = useState(null)

  const loadSettings = useCallback(async () => {
    try {
      const s = await getZenopaySettings()
      const merged = { ...defaultSettings(), ...s }
      setCfg(merged)
      setDraft(merged)
    } catch (e) {
      showToast('error', e?.message || 'Could not load ZenoPay settings')
    }
  }, [showToast])

  useEffect(() => {
    let cancelled = false
    const raf = requestAnimationFrame(() => {
      if (!cancelled) void loadSettings()
    })
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
    }
  }, [loadSettings])

  const dirty = useMemo(
    () =>
      draft.environment !== cfg.environment ||
      draft.apiEndpoint !== cfg.apiEndpoint ||
      draft.accountId !== cfg.accountId ||
      draft.apiKey !== cfg.apiKey ||
      draft.webhookUrl !== cfg.webhookUrl,
    [draft, cfg],
  )

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    try {
      const saved = await putZenopaySettings(draft)
      setCfg(saved)
      setDraft(saved)
      showFlash('success', 'ZenoPay settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    }
  }

  async function handleTestConnection() {
    setTesting(true)
    try {
      const result = await postZenopayTest({
        apiEndpoint: draft.apiEndpoint,
        apiKey: draft.apiKey,
        accountId: draft.accountId,
      })
      const ok = result?.ok === true
      const msg = String(result?.message || (ok ? 'OK' : 'Failed'))
      const next = {
        ...draft,
        lastTestAt: new Date().toISOString(),
        lastTestOk: ok,
        lastTestMessage: msg,
      }
      setDraft(next)
      const saved = await putZenopaySettings(next)
      setCfg(saved)
      showFlash(ok ? 'success' : 'error', msg)
    } catch (err) {
      showToast('error', err?.message || 'Test failed')
    }
    setTesting(false)
  }

  const connected = cfg.lastTestOk === true
  const failed = cfg.lastTestOk === false

  return (
    <>
      <Topbar />
      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        {flash ? (
          <FlashMessage type={flash.type} message={flash.message} onDismiss={() => setFlash(null)} />
        ) : null}

        <header>
          <h1 className="text-2xl font-bold text-white sm:text-3xl">ZenoPay Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Payment gateway configuration</p>
        </header>

        <form onSubmit={handleSave} className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">
              Connection
            </h2>

            <div className="flex items-center gap-3 rounded-xl border border-slate-600/50 bg-slate-900/50 px-4 py-3">
              <Wifi className="h-5 w-5 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase text-slate-500">Status</p>
                <p className="mt-0.5 flex items-center gap-2 text-sm font-medium">
                  {cfg.lastTestOk == null ? (
                    <span className="text-slate-400">Not tested yet</span>
                  ) : connected ? (
                    <>
                      <CheckCircle2 className="h-4 w-4 text-emerald-400" />
                      <span className="text-emerald-300">Connected</span>
                    </>
                  ) : (
                    <>
                      <XCircle className="h-4 w-4 text-red-400" />
                      <span className="text-red-300">Failed</span>
                    </>
                  )}
                </p>
                {cfg.lastTestAt ? (
                  <p className="mt-1 text-xs text-slate-500">
                    Last check: {new Date(cfg.lastTestAt).toLocaleString()}
                  </p>
                ) : null}
                {failed && cfg.lastTestMessage ? (
                  <p className="mt-1 text-xs text-red-400/90">{cfg.lastTestMessage}</p>
                ) : null}
              </div>
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-env">
                Environment
              </label>
              <select
                id="zp-env"
                value={draft.environment}
                onChange={(e) => setDraft((d) => ({ ...d, environment: e.target.value }))}
                className={inputClass()}
              >
                <option value="production">Production</option>
                <option value="test">Test</option>
              </select>
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-end">
                API endpoint (ZENO_ENDPOINT)
              </label>
              <input
                id="zp-end"
                value={draft.apiEndpoint}
                onChange={(e) => setDraft((d) => ({ ...d, apiEndpoint: e.target.value }))}
                placeholder="https://api.example.com/v1"
                className={inputClass()}
              />
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-acct">
                Account ID (ZENO_ACCOUNT_ID)
              </label>
              <input
                id="zp-acct"
                value={draft.accountId}
                onChange={(e) => setDraft((d) => ({ ...d, accountId: e.target.value }))}
                placeholder="Merchant / account identifier"
                className={inputClass()}
              />
            </div>

            <button
              type="button"
              onClick={handleTestConnection}
              disabled={testing}
              className="inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
            >
              {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Test Connection
            </button>
          </div>

          <div className="space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">
              Credentials
            </h2>

            <div>
              <label className={labelClass()} htmlFor="zp-key">
                API Key <span className="text-slate-500">(masked when saved)</span>
              </label>
              <input
                id="zp-key"
                type="password"
                autoComplete="off"
                value={draft.apiKey}
                onChange={(e) => setDraft((d) => ({ ...d, apiKey: e.target.value }))}
                placeholder="Enter API key"
                className={inputClass()}
              />
              <p className="mt-2 text-xs text-slate-500">
                Stored preview:{' '}
                <span className="font-mono text-slate-400">
                  {cfg.apiKeyMasked || maskKey(cfg.apiKey)}
                </span>
              </p>
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-url">
                Endpoint URL
              </label>
              <input id="zp-url" value={draft.apiEndpoint} readOnly className={`${inputClass()} opacity-80`} />
            </div>

            <div>
              <label className={labelClass()} htmlFor="zp-wh">
                Webhook URL
              </label>
              <input
                id="zp-wh"
                value={draft.webhookUrl}
                onChange={(e) => setDraft((d) => ({ ...d, webhookUrl: e.target.value }))}
                className={inputClass()}
              />
            </div>
          </div>

          <div className="xl:col-span-2 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setDraft({ ...cfg })}
              disabled={!dirty}
              className="rounded-xl border border-slate-600 px-6 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
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

export default ZenoPayPage
