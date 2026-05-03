import { useCallback, useEffect, useMemo, useState } from 'react'
import { Activity } from 'lucide-react'
import LiveUserLocationsCard from '../components/LiveUserLocationsCard'
import LiveUsersTrendSection from '../components/LiveUsersTrendSection'
import MostWatchedChannelsCard from '../components/MostWatchedChannelsCard'
import MostWatchedChannelsListCard from '../components/MostWatchedChannelsListCard'
import StatCard from '../components/StatCard'
import Topbar from '../components/Topbar'
import { useToast } from '../context/ToastContext.jsx'
import { getDashboard } from '../lib/api'

const emerald =
  'bg-gradient-to-br from-emerald-400/92 via-emerald-500/88 to-emerald-700/90'

function expandLocationsForCard(rows) {
  if (!Array.isArray(rows)) return []
  const out = []
  for (const row of rows) {
    const n = Math.min(5000, Math.max(0, Math.floor(Number(row.count) || 0)))
    for (let i = 0; i < n; i += 1) {
      out.push({
        countryCode: row.countryCode || 'TZ',
        countryName: row.countryName || 'Tanzania',
        status: 'online',
      })
    }
  }
  return out
}

function DashboardPage() {
  const { showToast } = useToast()
  const [dash, setDash] = useState(null)

  const load = useCallback(async () => {
    try {
      const d = await getDashboard()
      setDash(d)
    } catch (e) {
      showToast('error', e?.message || 'Could not load dashboard')
      setDash(null)
    }
  }, [showToast])

  useEffect(() => {
    load()
  }, [load])

  const installsFormatted = useMemo(() => {
    const n = Number(dash?.totalAppInstalls)
    if (!Number.isFinite(n) || n <= 0) return '0'
    return n.toLocaleString('en-TZ')
  }, [dash])

  const liveUsersList = useMemo(
    () => expandLocationsForCard(dash?.liveUsersByCountry),
    [dash],
  )

  const mostWatched = useMemo(() => {
    const ch = dash?.mostWatchedChannels
    return Array.isArray(ch) ? ch : []
  }, [dash])

  const section1Cards = [
    {
      gradientClass: emerald,
      className: 'dashboard-card',
      title: 'Total App Installs',
      value: installsFormatted,
      icon: Activity,
    },
  ]

  return (
    <>
      <Topbar />

      <main className="mt-6">
        <div className="overflow-x-auto">
          <section className="dashboard-grid">
            <StatCard key={`top-${section1Cards[0].title}`} {...section1Cards[0]} />
            <MostWatchedChannelsListCard channels={mostWatched} />
            <MostWatchedChannelsCard channels={mostWatched} />
            <LiveUserLocationsCard users={liveUsersList} />
          </section>
        </div>
        <LiveUsersTrendSection />
      </main>
    </>
  )
}

export default DashboardPage
