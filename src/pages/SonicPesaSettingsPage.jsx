import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Wifi, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'
import {
  getSonicpesaSettings,
  postSonicpesaTest,
  putSonicpesaSettings,
  syncStreamUrl,
} from '../lib/api'

function defaultSettings() {
  return {
    enabled: false,
    environment: 'sandbox',
    apiEndpoint: '',
    accountId: '',
    apiKey: '',
    hasApiKey: false,
    apiKeyMasked: '',
    webhookUrl: '',
    productionWebhookUrl: 'https://api.osmanitv.com/api/payments/sonicpesa/webhook',
    webhookUrlIsLegacyRender: false,
    webhookSecretConfigured: false,
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: '',
    envOverrideAny: false,
    envOverrideActive: null,
    isActiveCheckoutProvider: false,
    payment_provider: 'zenopay',
    lastWebhookAt: null,
    lastProviderWebhookAt: null,
    lastEngineeringProbeAt: null,
    lastWebhookEvent: '',
    lastWebhookOrderId: '',
    setAsActiveCheckoutProvider: false,
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

function SonicPesaSettingsPage() {
  const { showToast } = useToast()
  const [cfg, setCfg] = useState(() => defaultSettings())
  const [draft, setDraft] = useState(() => ({ ...defaultSettings() }))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [flash, setFlash] = useState(null)

  const productionWebhook =
    cfg.productionWebhookUrl ||
    cfg.production_webhook_url ||
    'https://api.osmanitv.com/api/payments/sonicpesa/webhook'

  const loadSettings = useCallback(async () => {
    try {
      const s = await getSonicpesaSettings()
      const prodWh =
        s?.productionWebhookUrl ??
        s?.production_webhook_url ??
        'https://api.osmanitv.com/api/payments/sonicpesa/webhook'
      const merged = {
        ...defaultSettings(),
        ...s,
        enabled: Boolean(s?.enabled),
        environment: String(s?.environment || 'sandbox').toLowerCase(),
        apiEndpoint: s?.apiEndpoint ?? s?.api_endpoint ?? '',
        accountId: s?.accountId ?? s?.account_id ?? '',
        webhookUrl: prodWh,
        productionWebhookUrl: prodWh,
        webhookUrlIsLegacyRender: Boolean(s?.webhookUrlIsLegacyRender),
        webhookSecretConfigured: Boolean(s?.webhookSecretConfigured),
        hasApiKey: Boolean(s?.hasApiKey),
        apiKeyMasked: String(s?.apiKeyMasked || '******'),
        envOverrideAny: Boolean(s?.envOverrideAny),
        envOverrideActive: s?.envOverrideActive ?? null,
        isActiveCheckoutProvider: Boolean(s?.isActiveCheckoutProvider),
        payment_provider: String(s?.payment_provider || 'zenopay'),
        lastWebhookAt: s?.lastWebhookAt ?? s?.last_webhook_at ?? null,
        lastProviderWebhookAt: s?.lastProviderWebhookAt ?? s?.last_provider_webhook_at ?? null,
        lastEngineeringProbeAt: s?.lastEngineeringProbeAt ?? s?.last_engineering_probe_at ?? null,
        lastWebhookEvent: String(s?.lastWebhookEvent ?? s?.last_webhook_event ?? ''),
        lastWebhookOrderId: String(s?.lastWebhookOrderId ?? s?.last_webhook_order_id ?? ''),
        setAsActiveCheckoutProvider: Boolean(s?.isActiveCheckoutProvider),
      }
      setCfg(merged)
      setDraft({ ...merged, apiKey: '', webhookUrl: prodWh })
    } catch (e) {
      showToast('error', e?.message || 'Could not load SonicPesa settings')
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

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    const onRefresh = () => {
      void loadSettings()
    }
    es.addEventListener('config.sonicpesa_settings_changed', onRefresh)
    return () => es.close()
  }, [loadSettings])

  const dirty = useMemo(
    () =>
      draft.enabled !== cfg.enabled ||
      draft.environment !== cfg.environment ||
      draft.apiEndpoint !== cfg.apiEndpoint ||
      draft.accountId !== cfg.accountId ||
      draft.webhookUrl !== cfg.webhookUrl ||
      draft.apiKey.trim() !== '' ||
      draft.setAsActiveCheckoutProvider !== cfg.setAsActiveCheckoutProvider,
    [draft, cfg],
  )

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    try {
      if (draft.enabled && !draft.apiEndpoint.trim() && !cfg.hasApiKey) {
        showToast('error', 'API endpoint is required when SonicPesa is enabled')
        setSaving(false)
        return
      }
      const payload = {
        enabled: draft.enabled,
        environment: draft.environment,
        apiEndpoint: draft.apiEndpoint.trim() || 'https://api.sonicpesa.com/api/v1',
        accountId: draft.accountId.trim(),
        webhookUrl: productionWebhook,
        setAsActiveCheckoutProvider: draft.setAsActiveCheckoutProvider,
        payment_provider: draft.setAsActiveCheckoutProvider ? 'sonicpesa' : undefined,
      }
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim()
      const saved = await putSonicpesaSettings(payload)
      setCfg(saved)
      setDraft((prev) => ({ ...saved, apiKey: prev.apiKey }))
      showFlash('success', 'SonicPesa settings saved.')
      showToast('success', 'SonicPesa settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleTestConnection() {
    setTesting(true)
    try {
      const result = await postSonicpesaTest({})
      const ok = result?.success === true
      const msg = String(result?.message || (ok ? 'OK' : 'Failed'))
      const next = {
        ...cfg,
        lastTestAt: new Date().toISOString(),
        lastTestOk: ok,
        lastTestMessage: msg,
      }
      setCfg(next)
      setDraft((prev) => ({ ...prev, ...next }))
      showFlash(ok ? 'success' : 'error', msg)
      showToast(ok ? 'success' : 'error', msg)
      void loadSettings()
    } catch (err) {
      showToast('error', err?.message || 'Test failed')
    } finally {
      setTesting(false)
    }
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

        {cfg.envOverrideAny ? (
          <div
            className="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-sm text-amber-100"
            role="status"
          >
            <p className="font-semibold text-amber-200">SONICPESA_* environment overrides active</p>
            <p className="mt-1 text-amber-100/90">
              The form shows values stored in PostgreSQL. Live requests may use endpoint, account, or key from
              process.env when set — the effective values used at runtime can differ from this form.
            </p>
          </div>
        ) : null}

        <header>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-white sm:text-3xl">SonicPesa Settings</h1>
            {cfg.isActiveCheckoutProvider ? (
              <span className="rounded-lg bg-emerald-500/20 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-emerald-200 ring-1 ring-emerald-400/40">
                Active checkout provider
              </span>
            ) : (
              <span className="rounded-lg bg-slate-700/60 px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide text-slate-400 ring-1 ring-slate-600/50">
                Not active provider
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Separate gateway configuration (does not replace{' '}
            <Link className="text-amber-400 underline hover:text-amber-300" to="/zenopay">
              ZenoPay
            </Link>
            ). Test checkout with provider selection on the ZenoPay page.
          </p>
        </header>

        <form onSubmit={handleSave} className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          <div className="space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">Connection</h2>

            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-slate-600/50 bg-slate-900/50 px-4 py-3">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => setDraft((d) => ({ ...d, enabled: e.target.checked }))}
                className="h-4 w-4 rounded border-slate-500 text-amber-500 focus:ring-amber-500/40"
              />
              <div>
                <p className="text-sm font-semibold text-slate-200">Enable SonicPesa at checkout</p>
                <p className="text-xs text-slate-500">When off, SonicPesa is hidden from the payment method list.</p>
              </div>
            </label>

            <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3">
              <input
                type="checkbox"
                checked={draft.setAsActiveCheckoutProvider}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, setAsActiveCheckoutProvider: e.target.checked }))
                }
                className="h-4 w-4 rounded border-slate-500 text-amber-500 focus:ring-amber-500/40"
              />
              <div>
                <p className="text-sm font-semibold text-slate-200">Use SonicPesa as active app checkout provider</p>
                <p className="text-xs text-slate-500">
                  Mobile app routes payments here when enabled (ZenoPay remains available when selected in admin).
                </p>
              </div>
            </label>

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
                    Last check: {formatAdminDateTime(cfg.lastTestAt, { fallback: '—' })}
                  </p>
                ) : null}
                {failed && cfg.lastTestMessage ? (
                  <p className="mt-1 text-xs text-red-400/90">{cfg.lastTestMessage}</p>
                ) : null}
              </div>
            </div>

            <div>
              <label className={labelClass()} htmlFor="sp-env">
                Environment
              </label>
              <select
                id="sp-env"
                value={draft.environment}
                onChange={(e) => setDraft((d) => ({ ...d, environment: e.target.value }))}
                className={inputClass()}
              >
                <option value="live">Live</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </div>

            <div>
              <label className={labelClass()} htmlFor="sp-end">
                API endpoint (SONICPESA_ENDPOINT)
              </label>
              <input
                id="sp-end"
                value={draft.apiEndpoint}
                onChange={(e) => setDraft((d) => ({ ...d, apiEndpoint: e.target.value }))}
                placeholder="https://api.example.com/v1"
                className={inputClass()}
              />
            </div>

            <div>
              <label className={labelClass()} htmlFor="sp-acct">
                Account / merchant ID (SONICPESA_ACCOUNT_ID)
              </label>
              <input
                id="sp-acct"
                value={draft.accountId}
                onChange={(e) => setDraft((d) => ({ ...d, accountId: e.target.value }))}
                placeholder="Merchant identifier"
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
              Test connection
            </button>
          </div>

          <div className="space-y-5 rounded-2xl border border-slate-700/60 bg-slate-950/40 p-6 ring-1 ring-white/[0.04]">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-amber-400/90">Credentials</h2>

            <div>
              <label className={labelClass()} htmlFor="sp-key">
                API key / secret <span className="text-slate-500">(masked when saved)</span>
              </label>
              <input
                id="sp-key"
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
                  {cfg.hasApiKey ? cfg.apiKeyMasked || '******' : maskKey(cfg.apiKey)}
                </span>
                {cfg.hasApiKey ? (
                  <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300">
                    Saved
                  </span>
                ) : null}
              </p>
            </div>

            <div>
              <label className={labelClass()} htmlFor="sp-wh">
                Production webhook URL (authoritative VPS — configure in SonicPesa dashboard)
              </label>
              <input
                id="sp-wh"
                readOnly
                value={productionWebhook}
                className={`${inputClass()} cursor-default opacity-90`}
              />
              {cfg.webhookUrlIsLegacyRender ? (
                <p className="mt-2 text-xs text-amber-300">
                  Legacy Render callback was detected and normalized to the authoritative VPS endpoint on save/deploy.
                </p>
              ) : null}
              <p className="mt-2 text-xs text-slate-500">
                POST target for SonicPesa <strong className="text-slate-400">payment.completed</strong> events.
                HMAC: set <code className="text-slate-400">SONICPESA_WEBHOOK_SECRET</code> on VPS and send{' '}
                <code className="text-slate-400">X-SonicPesa-Signature</code> (hex SHA-256 of raw JSON body).
                {cfg.webhookSecretConfigured ? (
                  <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300">
                    HMAC configured
                  </span>
                ) : (
                  <span className="ml-2 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-300">
                    HMAC not configured
                  </span>
                )}
              </p>
            </div>

            <div className="rounded-xl border border-slate-600/50 bg-slate-900/50 px-4 py-3 space-y-3">
              <p className="text-xs font-semibold uppercase text-slate-500">Webhook delivery status</p>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Real provider webhook</p>
                {cfg.lastProviderWebhookAt ? (
                  <p className="mt-1 text-sm text-emerald-300">
                    {formatAdminDateTime(cfg.lastProviderWebhookAt, { fallback: '—' })}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-amber-300">No provider-originated webhook received yet</p>
                )}
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Last engineering probe</p>
                {cfg.lastEngineeringProbeAt ? (
                  <p className="mt-1 text-sm text-slate-400">
                    {formatAdminDateTime(cfg.lastEngineeringProbeAt, { fallback: '—' })}
                  </p>
                ) : (
                  <p className="mt-1 text-sm text-slate-500">None recorded</p>
                )}
              </div>
              {cfg.lastWebhookEvent || cfg.lastWebhookOrderId ? (
                <p className="text-xs text-slate-500">
                  Last event: <span className="text-slate-300">{cfg.lastWebhookEvent || '—'}</span>
                  {cfg.lastWebhookOrderId ? (
                    <>
                      {' '}
                      · order <span className="font-mono text-slate-400">{cfg.lastWebhookOrderId}</span>
                    </>
                  ) : null}
                </p>
              ) : null}
            </div>
          </div>

          <div className="xl:col-span-2 flex justify-end gap-3">
            <button
              type="button"
              onClick={() => setDraft({ ...cfg, apiKey: '' })}
              disabled={!dirty || saving || testing}
              className="rounded-xl border border-slate-600 px-6 py-3 text-sm font-medium text-slate-300 hover:bg-slate-800 disabled:opacity-40"
            >
              Reset
            </button>
            <button
              type="submit"
              disabled={!dirty || saving || testing}
              className="rounded-xl bg-gradient-to-r from-amber-400 to-yellow-500 px-8 py-3 text-sm font-bold text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.35)] disabled:opacity-40"
            >
              {saving ? 'Saving…' : 'Save settings'}
            </button>
          </div>
        </form>
      </main>
    </>
  )
}

export default SonicPesaSettingsPage
