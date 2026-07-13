import { BrainCircuit } from 'lucide-react'
import DeviceIntelligenceRegistryView from '../components/DeviceIntelligenceRegistryView'

export default function UsersIntelligencePage() {
  return (
    <DeviceIntelligenceRegistryView
      title="Users Intelligence"
      description="Device registry, user detail, and block controls (additive — does not change billing)."
      icon={BrainCircuit}
    />
  )
}
