import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, Loader2 } from 'lucide-react'
import { useToast } from '../context/ToastContext.jsx'
import {
  getUsersIntelligenceDetail,
  postUsersIntelligenceBlock,
  postUsersIntelligenceUnblock,
} from '../lib/api'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

function Section({ title, children }) {
  return (
    <section className="rounded-2xl border border-slate-700/60 bg-slate-900/40 p-5">
      <h2 className="mb-4 text-sm font-bold uppercase tracking-wide text-amber-400/90">{title}</h2>
      {children}
    </section>
  )
}

function InfoGrid({ rows }) {
  return (
    <dl className="grid gap-3 sm:grid-cols-2">
      {rows.map(([label, value]) => (
        <div key={label}>
          <dt className="text-xs font-semibold uppercase text-slate-500">{label}</dt>
          <dd className="mt-1 break-all text-sm text-slate-100">{value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  )
}

function DataTable({ columns, rows, empty }) {
  if (!rows?.length) return <p className="text-sm text-slate-500">{empty}</p>
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] text-left text-xs">
        <thead>
          <tr className="border-b border-slate-700 text-slate-400">
            {columns.map((c) => (
              <th key={c.key} className="px-2 py-2 font-semibold">
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={row.id ?? row.order_id ?? i} className="border-b border-slate-800/80">
              {columns.map((c) => (
                <td key={c.key} className="px-2 py-2 text-slate-300">
                  {c.render ? c.render(row) : String(row[c.key] ?? '—')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function BlockModal({ open, loading, reason, onReason, onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <button type="button" className="absolute inset-0 bg-black/80" aria-label="Close" onClick={onCancel} />
      <div className="relative w-full max-w-md rounded-2xl border border-slate-600 bg-[#0f172a] p-6 shadow-2xl">
        <h3 className="text-lg font-bold text-white">Block user</h3>
        <p className="mt-2 text-sm text-slate-400">Enter a reason. The device will be blocked on next app check.</p>
        <textarea
          value={reason}
          onChange={(e) => onReason(e.target.value)}
          rows={3}
          className="mt-4 w-full rounded-xl border border-slate-600 bg-slate-900 px-3 py-2 text-sm text-slate-100"
          placeholder="Block reason (required)"
        />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-xl border border-slate-600 px-4 py-2 text-sm text-slate-300">
            Cancel
          </button>
          <button
            type="button"
            disabled={loading || !reason.trim()}
            onClick={onConfirm}
            className="rounded-xl bg-red-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {loading ? <Loader2 className="inline h-4 w-4 animate-spin" /> : 'BLOCK USER'}
          </button>
        </div>
      </div>
    </div>
  )
}

export default function UsersIntelligenceDetailPage() {
  const { id } = useParams()
  const navigate = useNavigate()
  const { showToast } = useToast()
  const [loading, setLoading] = useState(true)
  const [detail, setDetail] = useState(null)
  const [blockOpen, setBlockOpen] = useState(false)
  const [blockReason, setBlockReason] = useState('')
  const [actionLoading, setActionLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getUsersIntelligenceDetail(id)
      setDetail(data)
    } catch (e) {
      showToast(String(e.message || e), 'error')
    } finally {
      setLoading(false)
    }
  }, [id, showToast])

  useEffect(() => {
    void load()
  }, [load])

  async function handleBlock() {
    const reason = blockReason.trim()
    if (!reason) return
    setActionLoading(true)
    try {
      await postUsersIntelligenceBlock(id, { reason })
      showToast('User blocked', 'success')
      setBlockOpen(false)
      setBlockReason('')
      await load()
    } catch (e) {
      showToast(String(e.message || e), 'error')
    } finally {
      setActionLoading(false)
    }
  }

  async function handleUnblock() {
    setActionLoading(true)
    try {
      await postUsersIntelligenceUnblock(id, {})
      showToast('User unblocked', 'success')
      await load()
    } catch (e) {
      showToast(String(e.message || e), 'error')
    } finally {
      setActionLoading(false)
    }
  }

  const reg = detail?.registry
  const isBlocked = reg?.status === 'blocked'

  return (
    <div className="fixed inset-0 left-[280px] z-30 flex flex-col bg-[#0B0F1A]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => navigate('/users-intelligence')}
            className="rounded-xl border border-slate-600 p-2 text-slate-300 hover:bg-slate-800"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-white">User detail</h1>
            <p className="font-mono text-xs text-slate-400">{reg?.deviceId || id}</p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {isBlocked ? (
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => void handleUnblock()}
              className="rounded-xl border border-emerald-500/50 bg-emerald-600/20 px-4 py-2 text-sm font-bold text-emerald-200 hover:bg-emerald-600/30 disabled:opacity-50"
            >
              UNBLOCK USER
            </button>
          ) : (
            <button
              type="button"
              disabled={actionLoading}
              onClick={() => setBlockOpen(true)}
              className="rounded-xl border border-red-500/50 bg-red-600/20 px-4 py-2 text-sm font-bold text-red-200 hover:bg-red-600/30 disabled:opacity-50"
            >
              BLOCK USER
            </button>
          )}
        </div>
      </header>

      <div className="custom-scrollbar flex-1 overflow-y-auto px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center gap-2 py-20 text-slate-400">
            <Loader2 className="h-6 w-6 animate-spin" />
            Loading…
          </div>
        ) : !detail ? (
          <p className="text-slate-400">User not found.</p>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-6 pb-12">
            <Section title="Account Information">
              <InfoGrid
                rows={[
                  ['Account ID', detail.account?.accountId],
                  ['User ID', detail.account?.userId],
                  ['Phone', detail.account?.phoneNumber],
                  [
                    'Phone subscription',
                    detail.account?.phoneSubscription
                      ? `${detail.account.phoneSubscription.plan_name || 'plan'} · ${formatAdminDateTime(detail.account.phoneSubscription.expires_at)}`
                      : '—',
                  ],
                  [
                    'Security profile',
                    detail.account?.securityProfile
                      ? `${detail.account.securityProfile.securityLevel} / ${detail.account.securityProfile.adminStatus}`
                      : '—',
                  ],
                ]}
              />
            </Section>

            <Section title="Device Information">
              <InfoGrid
                rows={[
                  ['Device ID', detail.device?.deviceId],
                  ['Fingerprint', detail.device?.deviceFingerprint],
                  ['Android ID', detail.device?.androidId],
                  ['Brand / Model', [detail.device?.deviceBrand, detail.device?.deviceModel].filter(Boolean).join(' ')],
                  ['OS / App', `${detail.device?.osVersion || '—'} / ${detail.device?.appVersion || '—'}`],
                  ['Status', detail.device?.status],
                  ['First seen', formatAdminDateTime(detail.device?.firstSeenAt)],
                  ['Last seen', formatAdminDateTime(detail.device?.lastSeenAt)],
                  ['Block reason', detail.device?.blockReason || '—'],
                  ['Blocked by', detail.device?.blockedBy || '—'],
                  ['Blocked at', formatAdminDateTime(detail.device?.blockedAt)],
                ]}
              />
            </Section>

            <Section title="Payment History">
              <DataTable
                empty="No payments for this device."
                columns={[
                  { key: 'order_id', label: 'Order' },
                  { key: 'plan_name', label: 'Plan' },
                  { key: 'amount', label: 'Amount', render: (r) => `${r.amount} ${r.currency}` },
                  { key: 'status', label: 'Status' },
                  { key: 'created_at', label: 'Date', render: (r) => formatAdminDateTime(r.created_at) },
                ]}
                rows={detail.paymentHistory}
              />
            </Section>

            <Section title="Package Purchase History">
              <DataTable
                empty="No device subscription."
                columns={[
                  { key: 'status', label: 'Status' },
                  { key: 'transaction_id', label: 'Transaction' },
                  { key: 'expires_at', label: 'Expires', render: (r) => formatAdminDateTime(r.expires_at) },
                  { key: 'started_at', label: 'Started', render: (r) => formatAdminDateTime(r.started_at) },
                ]}
                rows={detail.packagePurchases}
              />
            </Section>

            <Section title="Package Transfer History">
              <DataTable
                empty="No outgoing transfers."
                columns={[
                  { key: 'transfer_code', label: 'Code' },
                  { key: 'target_device_id', label: 'Target device' },
                  { key: 'status', label: 'Status' },
                  { key: 'created_at', label: 'Created', render: (r) => formatAdminDateTime(r.created_at) },
                ]}
                rows={detail.packageTransferHistory}
              />
            </Section>

            <Section title="Received Transfers">
              <DataTable
                empty="No incoming transfers."
                columns={[
                  { key: 'transfer_code', label: 'Code' },
                  { key: 'source_device_id', label: 'Source device' },
                  { key: 'status', label: 'Status' },
                  { key: 'created_at', label: 'Created', render: (r) => formatAdminDateTime(r.created_at) },
                ]}
                rows={detail.receivedTransfers}
              />
            </Section>

            {detail.manualGrants?.length ? (
              <Section title="Manual grants">
                <DataTable
                  empty="None"
                  columns={[
                    { key: 'duration_days', label: 'Days' },
                    { key: 'created_at', label: 'Granted', render: (r) => formatAdminDateTime(r.created_at) },
                  ]}
                  rows={detail.manualGrants}
                />
              </Section>
            ) : null}

            <Section title="Login Activity">
              <DataTable
                empty="No login events yet."
                columns={[
                  { key: 'event_type', label: 'Event' },
                  { key: 'app_version', label: 'App' },
                  { key: 'ip_address', label: 'IP' },
                  { key: 'created_at', label: 'Time', render: (r) => formatAdminDateTime(r.created_at) },
                ]}
                rows={detail.loginActivity}
              />
            </Section>

            <Section title="Device History">
              <DataTable
                empty="No device history."
                columns={[
                  { key: 'change_summary', label: 'Change' },
                  { key: 'app_version', label: 'App' },
                  { key: 'device_model', label: 'Model' },
                  { key: 'recorded_at', label: 'Recorded', render: (r) => formatAdminDateTime(r.recorded_at) },
                ]}
                rows={detail.deviceHistory}
              />
            </Section>

            <Section title="Admin Actions">
              <DataTable
                empty="No admin actions."
                columns={[
                  { key: 'action', label: 'Action' },
                  { key: 'reason', label: 'Reason' },
                  { key: 'admin_email', label: 'Admin' },
                  { key: 'created_at', label: 'Time', render: (r) => formatAdminDateTime(r.created_at) },
                ]}
                rows={detail.adminActions}
              />
            </Section>
          </div>
        )}
      </div>

      <BlockModal
        open={blockOpen}
        loading={actionLoading}
        reason={blockReason}
        onReason={setBlockReason}
        onConfirm={() => void handleBlock()}
        onCancel={() => {
          setBlockOpen(false)
          setBlockReason('')
        }}
      />
    </div>
  )
}
