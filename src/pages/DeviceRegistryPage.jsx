import { useCallback, useState } from 'react'
import { HardDrive } from 'lucide-react'
import DeviceIntelligenceRegistryView from '../components/DeviceIntelligenceRegistryView'
import { useAnalyticsLiveRefresh } from '../hooks/useAnalyticsLiveRefresh.js'
import { getAnalyticsSnapshot } from '../lib/api'

/**
 * Device Registry — Total Unique Devices uses the historical physical-device census
 * (GET /analytics/snapshot → totalUniqueDevices), NOT Users Intelligence registry rows.
 * List/search/status filters still reuse the shared registry view (no backend list API change).
 */
export default function DeviceRegistryPage() {
  const [censusTotal, setCensusTotal] = useState(null)

  const loadCensus = useCallback(async () => {
    try {
      const snap = await getAnalyticsSnapshot()
      const n = Number(snap?.totalUniqueDevices)
      if (Number.isFinite(n) && n >= 0) setCensusTotal(n)
    } catch {
      /* keep last known census total */
    }
  }, [])

  useAnalyticsLiveRefresh(loadCensus, { pollMs: 15_000 })

  return (
    <DeviceIntelligenceRegistryView
      title="Device Registry"
      description="Physical unique devices that have ever installed or opened the app (installs ∪ telemetry census)."
      icon={HardDrive}
      showStatusFilter
      totalLabel="Total Unique Devices"
      totalOverride={censusTotal}
    />
  )
}
