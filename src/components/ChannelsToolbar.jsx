import { Plus } from 'lucide-react'
import ModeControlButton from './ModeControlButton'
import ModeStatusBadges from './ModeStatusBadges'

function ChannelsToolbar({
  isFreeMode,
  isEmergencyMode,
  isMaintenanceMode,
  isPhoneGateEnabled = true,
  modesDisabled = false,
  onFreeModeChange,
  onEmergencyModeChange,
  onMaintenanceModeChange,
  onPhoneGateChange,
  searchQuery,
  onSearchChange,
  onAddChannel,
}) {
  return (
    <div className="flex flex-col gap-5 xl:flex-row xl:items-center xl:justify-between xl:gap-6">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-3 sm:gap-y-2">
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <ModeControlButton
            variant="free"
            active={isFreeMode}
            disabled={modesDisabled}
            onToggle={onFreeModeChange}
            ariaLabel="Free Mode"
          />
          <ModeControlButton
            variant="emergency"
            active={isEmergencyMode}
            disabled={modesDisabled}
            onToggle={onEmergencyModeChange}
            ariaLabel="Emergency Mode"
          />
          <ModeControlButton
            variant="maintenance"
            active={isMaintenanceMode}
            disabled={modesDisabled}
            onToggle={onMaintenanceModeChange}
            ariaLabel="Maintenance Mode"
          />
          <ModeControlButton
            variant="phone"
            active={isPhoneGateEnabled}
            disabled={modesDisabled}
            onToggle={onPhoneGateChange}
            ariaLabel="Phone Number Gate"
          />
        </div>

        <div className="flex min-h-[44px] min-w-0 flex-1 flex-wrap items-center gap-2 sm:pl-1">
          <ModeStatusBadges
            isFreeMode={isFreeMode}
            isEmergencyMode={isEmergencyMode}
            isMaintenanceMode={isMaintenanceMode}
          />
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-3 sm:flex-row sm:items-center sm:justify-end xl:max-w-xl xl:flex-none xl:pl-2">
        <div className="relative min-w-0 flex-1 sm:max-w-xs xl:max-w-sm">
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => onSearchChange(e.target.value)}
            placeholder="Search channels…"
            className="w-full rounded-xl border border-white/10 bg-slate-950/40 py-3 pr-4 pl-4 text-sm text-slate-100 shadow-inner backdrop-blur-md placeholder:text-slate-500 focus:border-amber-500/35 focus:outline-none focus:ring-2 focus:ring-amber-500/20"
          />
        </div>
        <button
          type="button"
          onClick={onAddChannel}
          className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-2 rounded-full bg-gradient-to-r from-amber-400 to-yellow-500 px-6 py-2.5 text-xs font-bold uppercase tracking-[0.12em] text-slate-950 shadow-[0_8px_28px_rgba(251,191,36,0.28)] transition-all duration-300 hover:scale-[1.02] hover:brightness-105 active:scale-[0.98]"
        >
          <Plus className="h-4 w-4" strokeWidth={2.5} />
          Add Channel
        </button>
      </div>
    </div>
  )
}

export default ChannelsToolbar
