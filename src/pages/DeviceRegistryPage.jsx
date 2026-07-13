import { HardDrive } from 'lucide-react'
import DeviceIntelligenceRegistryView from '../components/DeviceIntelligenceRegistryView'

export default function DeviceRegistryPage() {
  return (
    <DeviceIntelligenceRegistryView
      title="Device Registry"
      description="Unique devices from the Users Intelligence registry — search, filter, and inspect device records."
      icon={HardDrive}
      showStatusFilter
      totalLabel="Total Unique Devices"
    />
  )
}
