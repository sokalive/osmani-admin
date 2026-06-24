import { ArrowDown, ArrowUp, ChevronsDown, ChevronsUp, Copy, GripVertical, Pencil, Trash2 } from 'lucide-react'
import ToggleSwitch from './ToggleSwitch'

function ChannelRow({
  channel,
  selected,
  onToggleSelected,
  onToggleAccess,
  onEdit,
  onDuplicate,
  onDelete,
  justAdded = false,
  duplicateDisabled = false,
  reorderDisabled = false,
  dragChannelId,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDrop,
  onMoveUp,
  onMoveDown,
  onMoveTop,
  onMoveBottom,
  canMoveUp = false,
  canMoveDown = false,
}) {
  const premium = channel.accessPremium === true
  const instruction = channel.isInstructionVideo === true
  const dragging = dragChannelId === channel.id

  return (
    <tr
      className={`group border-b border-white/[0.06] transition-colors duration-300 last:border-b-0 hover:bg-white/[0.045] ${
        justAdded
          ? 'bg-amber-500/[0.12] shadow-[0_0_24px_rgba(251,191,36,0.12)] ring-1 ring-amber-400/40 ring-inset'
          : ''
      } ${dragging ? 'bg-amber-500/10 ring-1 ring-amber-400/30 ring-inset' : ''}`}
      onDragOver={onDragOver}
      onDrop={onDrop}
    >
      <td className="w-12 px-3 py-5 align-middle">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelected()}
          className="h-4 w-4 rounded border-slate-500/80 bg-slate-900/80 text-emerald-500 focus:ring-emerald-500/40 focus:ring-offset-0 focus:ring-offset-transparent"
          aria-label={`Select ${channel.name}`}
        />
      </td>
      <td className="w-24 px-2 py-5 align-middle">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            draggable={!reorderDisabled}
            disabled={reorderDisabled}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
            className="rounded-lg p-1.5 text-slate-500 transition-colors hover:bg-white/10 hover:text-amber-300 disabled:cursor-not-allowed disabled:opacity-30"
            aria-label={`Drag ${channel.name}`}
          >
            <GripVertical className="h-4 w-4" />
          </button>
          <div className="flex flex-col">
            <button
              type="button"
              disabled={!canMoveUp || reorderDisabled}
              onClick={onMoveUp}
              className="rounded p-0.5 text-slate-500 hover:text-cyan-300 disabled:opacity-30"
              aria-label="Move up"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              disabled={!canMoveDown || reorderDisabled}
              onClick={onMoveDown}
              className="rounded p-0.5 text-slate-500 hover:text-cyan-300 disabled:opacity-30"
              aria-label="Move down"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </td>
      <td className="min-w-[200px] px-5 py-5 align-middle">
        <div className="flex min-w-0 items-center gap-4">
          {channel.thumbnail ? (
            <img
              src={channel.thumbnail}
              alt={channel.name}
              className="h-12 w-12 shrink-0 rounded-xl object-cover shadow-md ring-1 ring-white/15"
              width={48}
              height={48}
            />
          ) : (
            <div
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#6c5ce7] text-base font-bold text-white shadow-md ring-1 ring-white/15"
              aria-hidden
            >
              {channel.name?.charAt(0)?.toUpperCase() || 'S'}
            </div>
          )}
          <div className="min-w-0">
            <p className="truncate text-[15px] font-bold leading-tight tracking-tight text-white">
              {channel.name}
            </p>
            <p className="mt-1 truncate text-xs font-medium text-slate-500 lg:hidden">
              {channel.category}
              {channel.tabsLabel ? (
                <span className="block truncate text-[11px] text-slate-600">Tabs: {channel.tabsLabel}</span>
              ) : null}
            </p>
          </div>
        </div>
      </td>
      <td className="hidden px-5 py-5 align-middle lg:table-cell">
        <span className="text-sm text-slate-500">
          {channel.category}
          {channel.tabsLabel ? (
            <span className="mt-0.5 block text-[11px] text-slate-600">Tabs: {channel.tabsLabel}</span>
          ) : null}
        </span>
      </td>
      <td className="px-5 py-5 align-middle">
        <div className="flex flex-wrap items-center gap-3">
          <ToggleSwitch
            checked={premium}
            onChange={(next) => onToggleAccess(next)}
            disabled={instruction}
            aria-label={`${premium ? 'Premium' : 'Free'} access for ${channel.name}`}
          />
          {instruction ? (
            <span className="inline-flex items-center rounded-lg bg-cyan-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-300 ring-1 ring-cyan-400/35">
              Instruction
            </span>
          ) : premium ? (
            <span className="inline-flex items-center rounded-lg bg-yellow-500/15 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-yellow-300 ring-1 ring-yellow-400/35 shadow-[0_0_12px_rgba(234,179,8,0.12)]">
              Premium
            </span>
          ) : (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Free
            </span>
          )}
        </div>
      </td>
      <td className="px-5 py-5 align-middle">
        {channel.live ? (
          <span className="inline-flex items-center rounded-lg bg-emerald-500/20 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-emerald-300 shadow-[0_0_16px_rgba(34,197,94,0.25)] ring-1 ring-emerald-400/45">
            Live
          </span>
        ) : (
          <span className="inline-flex items-center rounded-lg bg-slate-700/50 px-3 py-1 text-[11px] font-bold uppercase tracking-[0.12em] text-slate-400 ring-1 ring-slate-600/50">
            Offline
          </span>
        )}
      </td>
      <td className="w-36 px-3 py-5 align-middle">
        <div className="flex flex-wrap items-center gap-1">
          <button
            type="button"
            disabled={reorderDisabled}
            onClick={onMoveTop}
            className="rounded-md border border-slate-600/60 px-1.5 py-1 text-[10px] font-bold text-slate-400 hover:bg-slate-800 disabled:opacity-30"
            title="Move to top"
          >
            <ChevronsUp className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            disabled={reorderDisabled}
            onClick={onMoveBottom}
            className="rounded-md border border-slate-600/60 px-1.5 py-1 text-[10px] font-bold text-slate-400 hover:bg-slate-800 disabled:opacity-30"
            title="Move to bottom"
          >
            <ChevronsDown className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={onEdit}
            className="rounded-xl p-2.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-amber-300"
            aria-label={`Edit ${channel.name}`}
          >
            <Pencil className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={onDuplicate}
            disabled={duplicateDisabled || instruction}
            className="rounded-xl p-2.5 text-slate-400 transition-colors hover:bg-white/10 hover:text-cyan-300 disabled:cursor-not-allowed disabled:opacity-40"
            aria-label={`Duplicate ${channel.name}`}
          >
            <Copy className="h-4 w-4" />
          </button>
          {!instruction ? (
          <button
            type="button"
            onClick={onDelete}
            className="rounded-xl p-2.5 text-slate-400 transition-colors hover:bg-red-500/15 hover:text-red-400"
            aria-label={`Delete ${channel.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </button>
          ) : null}
        </div>
      </td>
    </tr>
  )
}

export default ChannelRow
