import { Bell, Search } from 'lucide-react'

function Topbar() {
  return (
    <header className="flex flex-wrap items-center justify-between gap-4">
      <div>
        <p className="text-sm text-slate-400">Streaming control center</p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight text-white sm:text-[1.65rem]">
          Welcome back, Admin
        </h2>
      </div>
      <div className="flex items-center gap-3 rounded-[18px] border border-slate-700/60 bg-slate-900/60 px-3 py-2 shadow-[0_10px_30px_rgba(0,0,0,0.25)] sm:px-4 sm:py-3">
        <button
          type="button"
          className="rounded-xl p-2 text-slate-300 transition-colors duration-300 hover:scale-105 hover:bg-slate-800 hover:text-white"
          aria-label="Search"
        >
          <Search className="h-5 w-5" />
        </button>
        <button
          type="button"
          className="rounded-xl p-2 text-slate-300 transition-colors duration-300 hover:scale-105 hover:bg-slate-800 hover:text-white"
          aria-label="Notifications"
        >
          <Bell className="h-5 w-5" />
        </button>
        <div
          className="h-10 w-10 shrink-0 rounded-full border border-slate-500/60 bg-gradient-to-br from-amber-200 via-slate-300 to-slate-600 shadow-[0_8px_20px_rgba(0,0,0,0.3)]"
          role="img"
          aria-label="Admin profile"
        />
      </div>
    </header>
  )
}

export default Topbar
