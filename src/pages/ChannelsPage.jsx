import { useCallback, useEffect, useMemo, useState } from 'react'
import ChannelFormModal from '../components/ChannelFormModal'
import ChannelRow from '../components/ChannelRow'
import ChannelsToolbar from '../components/ChannelsToolbar'
import Topbar from '../components/Topbar'
import { useDeviceSubscription } from '../context/DeviceSubscriptionContext.jsx'
import { useToast } from '../context/ToastContext.jsx'
import {
  addChannelFormData,
  deleteChannel,
  duplicateChannel,
  getChannels,
  postChannelsReorder,
  putAppGlobalSettings,
  syncStreamUrl,
  updateChannel,
  updateChannelFormData,
  uploadInstructionVideo,
} from '../lib/api'
import { apiBodyFromUiChannel, channelFormDataFromSubmit, uiFromApiRow } from '../lib/channelApiModel'
import { formatAdminDateTime } from '../lib/formatAdminDateTime'

function reorderById(list, fromId, toId) {
  const next = [...list]
  const fi = next.findIndex((x) => String(x.id) === String(fromId))
  const ti = next.findIndex((x) => String(x.id) === String(toId))
  if (fi < 0 || ti < 0 || fi === ti) return list
  const [row] = next.splice(fi, 1)
  next.splice(ti, 0, row)
  return next
}

function ChannelsPage() {
  const { showToast } = useToast()
  const {
    isSubscribed,
    expiresAt,
    subscriptionStatus,
    blocked,
    blockReason,
    playbackAllowed,
    playbackGateReason,
    appModes,
    appModesReady,
    applyAppModesPayload,
    refreshAppModes,
  } = useDeviceSubscription()
  const [searchQuery, setSearchQuery] = useState('')

  const [channels, setChannels] = useState([])
  const [selectedIds, setSelectedIds] = useState(() => new Set())
  const [editingChannel, setEditingChannel] = useState(null)
  const [addModalOpen, setAddModalOpen] = useState(false)
  const [modesSaving, setModesSaving] = useState(false)
  const [dragChannelId, setDragChannelId] = useState(null)
  const [reorderBusy, setReorderBusy] = useState(false)
  const [duplicateBusyId, setDuplicateBusyId] = useState(null)
  const [highlightChannelId, setHighlightChannelId] = useState(null)

  const isFreeMode = appModes.free_mode === true
  const isEmergencyMode = appModes.emergency_mode === true
  const isMaintenanceMode = appModes.maintenance_mode === true

  const loadChannels = useCallback(async () => {
    try {
      const data = await getChannels()
      console.log('getChannels() raw response:', data)
      const list = Array.isArray(data) ? data : []
      console.log('getChannels() parsed list length:', list.length)
      setChannels(list.map(uiFromApiRow))
    } catch (e) {
      console.error('loadChannels failed:', e)
      showToast('error', e?.message || 'Could not load channels')
      setChannels([])
    }
  }, [showToast])

  useEffect(() => {
    loadChannels()
  }, [loadChannels])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void refreshAppModes().catch(() => {
        /* older API without /settings */
      })
    }, 0)
    return () => window.clearTimeout(timer)
  }, [refreshAppModes])

  useEffect(() => {
    const es = new EventSource(syncStreamUrl(['config']))
    es.addEventListener('app_modes', (ev) => {
      try {
        applyAppModesPayload(JSON.parse(ev.data))
      } catch {
        /* ignore malformed app_modes */
      }
    })
    const onChanged = () => {
      void refreshAppModes().catch(() => {
        /* older API without /settings */
      })
    }
    const onChannelsChanged = () => {
      void loadChannels()
    }
    es.addEventListener('config.settings_changed', onChanged)
    es.addEventListener('config.channels_changed', onChannelsChanged)
    return () => es.close()
  }, [applyAppModesPayload, loadChannels, refreshAppModes])

  async function persistAppModes(partial) {
    const next = {
      freeMode: partial.freeMode !== undefined ? partial.freeMode : isFreeMode,
      emergencyMode: partial.emergencyMode !== undefined ? partial.emergencyMode : isEmergencyMode,
      maintenanceMode:
        partial.maintenanceMode !== undefined ? partial.maintenanceMode : isMaintenanceMode,
    }
    try {
      setModesSaving(true)
      const saved = await putAppGlobalSettings(next)
      applyAppModesPayload(saved)
    } catch (e) {
      showToast('error', e?.message || 'Could not save app modes')
      void refreshAppModes().catch(() => {
        /* ignore rollback refresh failure */
      })
    } finally {
      setModesSaving(false)
    }
  }

  const sortedChannels = useMemo(() => {
    return [...channels].sort((a, b) => {
      const da = Number(a.sortOrder) || 0
      const db = Number(b.sortOrder) || 0
      if (da !== db) return da - db
      return Number(a.id) - Number(b.id)
    })
  }, [channels])

  const reorderDisabled = searchQuery.trim().length > 0 || reorderBusy

  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return sortedChannels
    return sortedChannels.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.category.toLowerCase().includes(q),
    )
  }, [sortedChannels, searchQuery])

  const persistSortOrder = useCallback(
    async (ordered) => {
      setReorderBusy(true)
      try {
        const orders = ordered.map((c, i) => ({
          id: Number(c.id),
          sortOrder: i,
        }))
        await postChannelsReorder(orders)
        await loadChannels()
        showToast('success', 'Channel order saved')
      } catch (e) {
        showToast('error', e?.message || 'Could not save order')
        await loadChannels()
      } finally {
        setReorderBusy(false)
      }
    },
    [loadChannels, showToast],
  )

  const applyReorder = useCallback(
    (nextList) => {
      setChannels(nextList)
      void persistSortOrder(nextList)
    },
    [persistSortOrder],
  )

  const moveChannelToIndex = useCallback(
    (id, toIndex) => {
      const next = [...sortedChannels]
      const fromIndex = next.findIndex((c) => String(c.id) === String(id))
      if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return
      const [row] = next.splice(fromIndex, 1)
      next.splice(toIndex, 0, row)
      applyReorder(next)
    },
    [applyReorder, sortedChannels],
  )

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((c) => selectedIds.has(c.id))

  function toggleSelectAll() {
    if (allFilteredSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        filtered.forEach((c) => next.delete(c.id))
        return next
      })
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev)
        filtered.forEach((c) => next.add(c.id))
        return next
      })
    }
  }

  function toggleRow(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleDuplicate(channel) {
    if (!channel?.id || duplicateBusyId) return
    setDuplicateBusyId(channel.id)
    try {
      const created = await duplicateChannel(channel.id)
      await loadChannels()
      const ui = uiFromApiRow(created)
      setAddModalOpen(false)
      setEditingChannel(ui)
      setHighlightChannelId(ui.id)
      window.setTimeout(() => setHighlightChannelId(null), 4000)
      showToast('success', `Channel duplicated — edit “${ui.name}” and save when ready.`)
    } catch (e) {
      showToast('error', e?.message || 'Could not duplicate channel')
      await loadChannels()
    } finally {
      setDuplicateBusyId(null)
    }
  }

  async function handleDelete(id) {
    try {
      await deleteChannel(id)
      await loadChannels()
      setSelectedIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    } catch (e) {
      showToast('error', e?.message || 'Delete failed')
      await loadChannels()
    }
  }

  async function handleToggleAccess(id, nextPremium) {
    const ch = channels.find((c) => c.id === id)
    if (!ch || ch.isInstructionVideo) return
    try {
      await updateChannel(id, apiBodyFromUiChannel({ ...ch, accessPremium: nextPremium }))
      await loadChannels()
    } catch (e) {
      showToast('error', e?.message || 'Update failed')
      await loadChannels()
    }
  }

  function closeModal() {
    setAddModalOpen(false)
    setEditingChannel(null)
  }

  async function handleModalSubmit(submitPayload) {
    try {
      const fd = channelFormDataFromSubmit(submitPayload)
      if (editingChannel) {
        await updateChannelFormData(editingChannel.id, fd)
        if (submitPayload.instructionVideoFile instanceof Blob) {
          await uploadInstructionVideo(editingChannel.id, submitPayload.instructionVideoFile)
        }
      } else {
        await addChannelFormData(fd)
      }
      await loadChannels()
      closeModal()
    } catch (e) {
      showToast('error', e?.message || 'Save failed')
      await loadChannels()
    }
  }

  const modalOpen = addModalOpen || editingChannel != null

  return (
    <>
      <Topbar />

      <main className="mt-6 flex min-h-0 flex-1 flex-col gap-6">
        <header className="shrink-0">
          <p className="text-xs font-semibold uppercase tracking-[0.2em] text-amber-400/90">
            Live streaming
          </p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-white sm:text-3xl">
            Channels
          </h1>
          <p className="mt-1 max-w-xl text-sm text-slate-400">
            Drag the handle or use arrows to reorder. App clients use saved order within each tab/category.
            {reorderDisabled && searchQuery.trim() ? ' Clear search to reorder.' : ''}
          </p>
          {isEmergencyMode ? (
            <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              Emergency mode active. Runtime clients should stop playback immediately and keep channels hidden
              until the backend mode clears.
            </p>
          ) : isMaintenanceMode ? (
            <p className="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
              Maintenance mode active. Playback remains soft-disabled by backend runtime gating while the shell
              stays online.
            </p>
          ) : isFreeMode ? (
            <p className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              Free mode active. Runtime clients can bypass the paywall while the backend remains the source of
              truth for mode changes.
            </p>
          ) : null}
          {isSubscribed ? (
            <p className="mt-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
              Device subscription active
              {expiresAt ? ` · until ${formatAdminDateTime(expiresAt)}` : ''} · playback{' '}
              {`${playbackAllowed ? 'allowed' : playbackGateReason ? `disabled (${playbackGateReason})` : 'checking'}.`}
            </p>
          ) : blocked ? (
            <p className="mt-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
              Device subscription {subscriptionStatus || 'blocked'}
              {blockReason ? ` · ${blockReason}` : ''}.
            </p>
          ) : null}
        </header>

        <ChannelsToolbar
          isFreeMode={isFreeMode}
          isEmergencyMode={isEmergencyMode}
          isMaintenanceMode={isMaintenanceMode}
          modesDisabled={!appModesReady || modesSaving}
          onFreeModeChange={(v) => {
            void persistAppModes({ freeMode: v })
          }}
          onEmergencyModeChange={(v) => {
            void persistAppModes({ emergencyMode: v })
          }}
          onMaintenanceModeChange={(v) => {
            void persistAppModes({ maintenanceMode: v })
          }}
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          onAddChannel={() => {
            setEditingChannel(null)
            setAddModalOpen(true)
          }}
        />
        {playbackGateReason === 'emergency_mode' || playbackGateReason === 'maintenance_mode' ? (
          <p className="text-xs text-slate-400">
            Current runtime gate reason: <span className="font-semibold text-slate-200">{playbackGateReason}</span>
          </p>
        ) : null}

        <div className="overflow-hidden rounded-2xl border border-white/10 bg-slate-950/45">
          <div className="overflow-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr>
                  <th>
                    <input
                      type="checkbox"
                      checked={allFilteredSelected}
                      onChange={toggleSelectAll}
                    />
                  </th>
                  <th>Channel</th>
                  <th>Category</th>
                  <th>Access</th>
                  <th>Status</th>
                  <th></th>
                </tr>
              </thead>

              <tbody>
                {filtered.map((channel) => {
                  const globalIndex = sortedChannels.findIndex((c) => c.id === channel.id)
                  return (
                    <ChannelRow
                      key={channel.id}
                      channel={channel}
                      selected={selectedIds.has(channel.id)}
                      justAdded={highlightChannelId === channel.id}
                      onToggleSelected={() => toggleRow(channel.id)}
                      onToggleAccess={(next) => handleToggleAccess(channel.id, next)}
                      onEdit={() => {
                        setAddModalOpen(false)
                        setEditingChannel(channel)
                      }}
                      onDuplicate={() => void handleDuplicate(channel)}
                      duplicateDisabled={duplicateBusyId != null}
                      onDelete={() => handleDelete(channel.id)}
                      reorderDisabled={reorderDisabled || duplicateBusyId != null}
                      dragChannelId={dragChannelId}
                      canMoveUp={globalIndex > 0}
                      canMoveDown={globalIndex >= 0 && globalIndex < sortedChannels.length - 1}
                      onDragStart={(e) => {
                        e.dataTransfer.setData('text/plain', String(channel.id))
                        e.dataTransfer.effectAllowed = 'move'
                        setDragChannelId(channel.id)
                      }}
                      onDragEnd={() => setDragChannelId(null)}
                      onDragOver={(e) => {
                        e.preventDefault()
                        e.dataTransfer.dropEffect = 'move'
                      }}
                      onDrop={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        const fromId = e.dataTransfer.getData('text/plain')
                        if (!fromId || String(fromId) === String(channel.id)) return
                        const next = reorderById(sortedChannels, fromId, channel.id)
                        if (next === sortedChannels) return
                        setDragChannelId(null)
                        applyReorder(next)
                      }}
                      onMoveUp={() => moveChannelToIndex(channel.id, globalIndex - 1)}
                      onMoveDown={() => moveChannelToIndex(channel.id, globalIndex + 1)}
                      onMoveTop={() => moveChannelToIndex(channel.id, 0)}
                      onMoveBottom={() => moveChannelToIndex(channel.id, sortedChannels.length - 1)}
                    />
                  )
                })}
              </tbody>
            </table>

            {filtered.length === 0 && (
              <p className="p-6 text-center text-gray-400">No channels found</p>
            )}
          </div>
        </div>
      </main>

      <ChannelFormModal
        variant={editingChannel ? 'edit' : 'add'}
        isOpen={modalOpen}
        channel={editingChannel}
        onClose={closeModal}
        onSubmit={handleModalSubmit}
      />
    </>
  )
}

export default ChannelsPage
