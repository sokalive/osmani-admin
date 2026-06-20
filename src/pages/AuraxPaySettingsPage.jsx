import { useCallback, useEffect, useMemo, useState } from 'react'
import { CheckCircle2, Loader2, Wifi, XCircle } from 'lucide-react'
import { Link } from 'react-router-dom'
import FlashMessage from '../components/FlashMessage'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import {
  API_ORIGIN,
  getAuraxpaySettings,
  postAuraxpayTest,
  putAuraxpaySettings,
  syncStreamUrl,
} from '../lib/api'

function defaultSettings() {
  return {
    enabled: false,
    environment: 'sandbox',
    apiEndpoint: '',
    accountId: '',
    apiKey: '',
    signingSecret: '',
    hasApiKey: false,
    hasSigningSecret: false,
    apiKeyMasked: '',
    signingSecretMasked: '',
    webhookUrl: '',
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: '',
    envOverrideAny: false,
    envOverrideActive: null,
    isActiveCheckoutProvider: false,
    payment_provider: 'zenopay',
    lastWebhookAt: null,
    lastWebhookEvent: '',
    lastWebhookOrderId: '',
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

function AuraxPaySettingsPage() {
  const { showToast } = useToast()
  const [cfg, setCfg] = useState(() => defaultSettings())
  const [draft, setDraft] = useState(() => ({ ...defaultSettings() }))
  const [saving, setSaving] = useState(false)
  const [testing, setTesting] = useState(false)
  const [settingActive, setSettingActive] = useState(false)
  const [flash, setFlash] = useState(null)

  const defaultWebhook = `${String(API_ORIGIN).replace(/\/$/, '')}/api/payments/auraxpay/webhook`

  const loadSettings = useCallback(async () => {
    try {
      const s = await getAuraxpaySettings()
      const merged = {
        ...defaultSettings(),
        ...s,
        enabled: Boolean(s?.enabled),
        environment: String(s?.environment || 'sandbox').toLowerCase(),
        apiEndpoint: s?.apiEndpoint ?? s?.api_endpoint ?? '',
        accountId: s?.accountId ?? s?.account_id ?? '',
        hasSigningSecret: Boolean(s?.hasSigningSecret),
        signingSecretMasked: String(s?.signingSecretMasked || ''),
        webhookUrl: s?.webhookUrl ?? s?.webhook_url ?? defaultWebhook,
        hasApiKey: Boolean(s?.hasApiKey),
        apiKeyMasked: String(s?.apiKeyMasked || '******'),
        envOverrideAny: Boolean(s?.envOverrideAny),
        envOverrideActive: s?.envOverrideActive ?? null,
        isActiveCheckoutProvider: Boolean(s?.isActiveCheckoutProvider),
        payment_provider: String(s?.payment_provider || 'zenopay'),
        lastWebhookAt: s?.lastWebhookAt ?? s?.last_webhook_at ?? null,
        lastWebhookEvent: String(s?.lastWebhookEvent ?? s?.last_webhook_event ?? ''),
        lastWebhookOrderId: String(s?.lastWebhookOrderId ?? s?.last_webhook_order_id ?? ''),
      }
      setCfg(merged)
      setDraft({ ...merged, apiKey: '' })
    } catch (e) {
      showToast('error', e?.message || 'Could not load Aurax Pay settings')
    }
  }, [defaultWebhook, showToast])

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
    es.addEventListener('config.auraxpay_settings_changed', onRefresh)
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
      draft.signingSecret.trim() !== '',
    [draft, cfg],
  )

  const gatewayLive = cfg.enabled === true
  const connected = cfg.lastTestOk === true
  const failed = cfg.lastTestOk === false

  function showFlash(type, message) {
    setFlash({ type, message })
    window.setTimeout(() => setFlash(null), 4000)
  }

  async function handleSave(e) {
    e.preventDefault()
    setSaving(true)
    try {
      if (draft.enabled && !draft.apiEndpoint.trim() && !cfg.hasApiKey) {
        showToast('error', 'API endpoint is required when Aurax Pay is enabled')
        setSaving(false)
        return
      }
      const payload = {
        enabled: draft.enabled,
        environment: draft.environment,
        apiEndpoint: draft.apiEndpoint.trim(),
        accountId: draft.accountId.trim(),
        webhookUrl: draft.webhookUrl.trim() || defaultWebhook,
      }
      if (draft.apiKey.trim()) payload.apiKey = draft.apiKey.trim()
      if (draft.signingSecret.trim()) payload.signingSecret = draft.signingSecret.trim()
      const saved = await putAuraxpaySettings(payload)
      setCfg(saved)
      setDraft((prev) => ({ ...saved, apiKey: prev.apiKey }))
      showFlash('success', 'Aurax Pay settings saved.')
      showToast('success', 'Aurax Pay settings saved.')
    } catch (err) {
      showToast('error', err?.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  async function handleSetActiveProvider() {
    if (!cfg.enabled && !draft.enabled) {
      showToast('error', 'Enable Aurax Pay before setting it as the active checkout provider')
      return
    }
    setSettingActive(true)
    try {
      const saved = await putAuraxpaySettings({
        enabled: draft.enabled,
        environment: draft.environment,
        apiEndpoint: draft.apiEndpoint.trim(),
        accountId: draft.accountId.trim(),
        webhookUrl: draft.webhookUrl.trim() || defaultWebhook,
        setAsActiveCheckoutProvider: true,
        payment_provider: 'auraxpay',
      })
      setCfg(saved)
      setDraft((prev) => ({ ...saved, apiKey: prev.apiKey }))
      showFlash('success', 'Aurax Pay is now the active checkout provider.')
      showToast('success', 'Aurax Pay is now the active checkout provider.')
    } catch (err) {
      showToast('error', err?.message || 'Could not set active provider')
    } finally {
      setSettingActive(false)
    }
  }

  async function handleTestConnection() {
    setTesting(true)
    try {
      const result = await postAuraxpayTest({})
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
            <p className="font-semibold text-amber-200">AURAXPAY_* environment overrides active</p>
            <p className="mt-1 text-amber-100/90">
              The form shows values stored in PostgreSQL. Live requests may use endpoint, account, or key from
              process.env when set — the effective values used at runtime can differ from this form.
            </p>
          </div>
        ) : null}

        <header>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold text-white sm:text-3xl">Aurax Pay Settings</h1>
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
            Third payment gateway (additive —{' '}
            <Link className="text-amber-400 underline hover:text-amber-300" to="/zenopay">
              ZenoPay
            </Link>{' '}
            and{' '}
            <Link className="text-amber-400 underline hover:text-amber-300" to="/sonicpesa">
              SonicPesa
            </Link>{' '}
            remain unchanged). Test checkout with provider selection on the ZenoPay page.
          </p>
        </header>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div
            className={`rounded-2xl border p-5 ring-1 ${
              gatewayLive
                ? 'border-emerald-500/40 bg-emerald-500/10 ring-emerald-400/20'
                : 'border-slate-600/50 bg-slate-900/50 ring-white/[0.04]'
            }`}
            role="status"
          >
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Gateway state</p>
            <p className="mt-2 flex items-center gap-2 text-lg font-bold">
              {gatewayLive ? (
                <>
                  <CheckCircle2 className="h-5 w-5 text-emerald-400" />
                  <span className="text-emerald-200">Live</span>
                </>
              ) : (
                <>
                  <XCircle className="h-5 w-5 text-slate-500" />
                  <span className="text-slate-400">Disabled</span>
                </>
              )}
            </p>
            <p className="mt-1 text-xs text-slate-500">
              {gatewayLive
                ? 'Aurax Pay is enabled and eligible for checkout when credentials are configured.'
                : 'Enable the switch below to offer Aurax Pay at checkout.'}
            </p>
          </div>

          <div className="rounded-2xl border border-slate-600/50 bg-slate-900/50 p-5 ring-1 ring-white/[0.04]">
            <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Active provider</p>
            <p className="mt-2 text-lg font-bold text-slate-100">
              {cfg.isActiveCheckoutProvider ? 'Aurax Pay' : `Other (${cfg.payment_provider || 'zenopay'})`}
            </p>
            <button
              type="button"
              onClick={handleSetActiveProvider}
              disabled={settingActive || saving || cfg.isActiveCheckoutProvider}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2.5 text-sm font-semibold text-amber-200 transition-colors hover:bg-amber-500/20 disabled:opacity-50"
            >
              {settingActive ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Set as active checkout provider
            </button>
          </div>
        </div>

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
                <p className="text-sm font-semibold text-slate-200">Enable Aurax Pay at checkout</p>
                <p className="text-xs text-slate-500">When off, Aurax Pay is hidden from the payment method list.</p>
              </div>
            </label>

            <div className="flex items-center gap-3 rounded-xl border border-slate-600/50 bg-slate-900/50 px-4 py-3">
              <Wifi className="h-5 w-5 shrink-0 text-slate-400" />
              <div className="min-w-0 flex-1">
                <p className="text-xs font-semibold uppercase text-slate-500">Connection test</p>
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
              <label className={labelClass()} htmlFor="ax-env">
                Environment
              </label>
              <select
                id="ax-env"
                value={draft.environment}
                onChange={(e) => setDraft((d) => ({ ...d, environment: e.target.value }))}
                className={inputClass()}
              >
                <option value="live">Live</option>
                <option value="sandbox">Sandbox</option>
              </select>
            </div>

            <div>
              <label className={labelClass()} htmlFor="ax-end">
                API endpoint (AURAXPAY_ENDPOINT or AURAXPAY_BASE_URL)
              </label>
              <input
                id="ax-end"
                value={draft.apiEndpoint}
                onChange={(e) => setDraft((d) => ({ ...d, apiEndpoint: e.target.value }))}
                placeholder="https://api.auraxpay.net/v1"
                className={inputClass()}
              />
            </div>

            <div>
              <label className={labelClass()} htmlFor="ax-acct">
                Phone Number / Merchant Phone{' '}
                <span className="text-slate-500">(AuraxPay account id — e.g. 255XXXXXXXXX)</span>
              </label>
              <input
                id="ax-acct"
                type="tel"
                inputMode="tel"
                autoComplete="tel"
                value={draft.accountId}
                onChange={(e) => setDraft((d) => ({ ...d, accountId: e.target.value }))}
                placeholder="255678089174 or 0678089174"
                className={inputClass()}
              />
              <p className="mt-1.5 text-xs text-slate-500">
                Stored as merchant account id for AuraxPay collect API (normalized to 255… digits).
              </p>
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
              <label className={labelClass()} htmlFor="ax-key">
                API key / secret <span className="text-slate-500">(masked when saved)</span>
              </label>
              <input
                id="ax-key"
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
              <label className={labelClass()} htmlFor="ax-sign">
                Signing secret <span className="text-slate-500">(API + webhook HMAC, masked when saved)</span>
              </label>
              <input
                id="ax-sign"
                type="password"
                autoComplete="off"
                value={draft.signingSecret}
                onChange={(e) => setDraft((d) => ({ ...d, signingSecret: e.target.value }))}
                placeholder="AURAXPAY_SIGNING_SECRET / AURAXPAY_WEBHOOK_SECRET"
                className={inputClass()}
              />
              <p className="mt-2 text-xs text-slate-500">
                Stored preview:{' '}
                <span className="font-mono text-slate-400">
                  {cfg.hasSigningSecret ? cfg.signingSecretMasked || '******' : '—'}
                </span>
                {cfg.hasSigningSecret ? (
                  <span className="ml-2 rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-emerald-300">
                    Saved
                  </span>
                ) : null}
              </p>
            </div>

            <div>
              <label className={labelClass()} htmlFor="ax-wh">
                Webhook URL (configure in Aurax Pay dashboard)
              </label>
              <input
                id="ax-wh"
                value={draft.webhookUrl || defaultWebhook}
                onChange={(e) => setDraft((d) => ({ ...d, webhookUrl: e.target.value }))}
                className={inputClass()}
              />
              <p className="mt-2 text-xs text-slate-500">
                POST target for payment events. Alias:{' '}
                <code className="text-slate-400">/api/webhooks/aurax</code>. Optional HMAC: set{' '}
                <code className="text-slate-400">AURAXPAY_WEBHOOK_SECRET</code> on the server and send{' '}
                <code className="text-slate-400">x-auraxpay-signature</code> (hex SHA-256 of raw JSON body).
              </p>
            </div>

            <div className="rounded-xl border border-slate-600/50 bg-slate-900/50 px-4 py-3">
              <p className="text-xs font-semibold uppercase text-slate-500">Webhook status</p>
              {cfg.lastWebhookAt ? (
                <>
                  <p className="mt-1 text-sm text-slate-200">
                    Last event:{' '}
                    <span className="font-medium text-emerald-300">{cfg.lastWebhookEvent || 'received'}</span>
                  </p>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {new Date(cfg.lastWebhookAt).toLocaleString()}
                    {cfg.lastWebhookOrderId ? (
                      <>
                        {' '}
                        · order <span className="font-mono text-slate-400">{cfg.lastWebhookOrderId}</span>
                      </>
                    ) : null}
                  </p>
                </>
              ) : (
                <p className="mt-1 text-sm text-slate-400">No webhook received yet</p>
              )}
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

export default AuraxPaySettingsPage
