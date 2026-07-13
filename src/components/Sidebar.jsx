import { NavLink, useNavigate } from 'react-router-dom'
import {
  BarChart3,
  Bell,
  BrainCircuit,
  Building2,
  Clock,
  CreditCard,
  Download,
  KeyRound,
  HandHelping,
  ClipboardList,
  Gift,
  HardDrive,
  LayoutDashboard,
  Layers,
  LogOut,
  PanelLeftClose,
  MessageCircle,
  MessageSquare,
  Search,
  Server,
  ShieldAlert,
  ShieldCheck,
  Tag,
  Tv,
  Users,
  WalletCards,
  Landmark,
  CircleDollarSign,
  PanelTopOpen,
  TabletSmartphone,
} from 'lucide-react'
import { useAdminAuth } from '../context/AdminAuthContext.jsx'

const menuItems = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard, path: '/' },
  { id: 'channels', label: 'Channels', icon: Tv, path: '/channels' },
  { id: 'banners', label: 'Banners', icon: Layers, path: '/banners' },
  { id: 'plans', label: 'Plans', icon: Tag, path: '/plans' },
  { id: 'manual-subscription', label: 'Toa Kifurushi', icon: Gift, path: '/manual-subscription' },
  { id: 'subscription-requests', label: 'Omba Kifurushi', icon: HandHelping, path: '/subscription-requests' },
  { id: 'payment-orders', label: 'Payment Orders', icon: ClipboardList, path: '/payment-orders' },
  { id: 'transactions', label: 'Transactions', icon: CreditCard, path: '/transactions' },
  { id: 'users', label: 'Users', icon: Users, path: '/users' },
  { id: 'customer-investigation', label: 'Uchunguzi wa Mteja', icon: Search, path: '/customer-investigation' },
  {
    id: 'users-intelligence',
    label: 'Users Intelligence',
    icon: BrainCircuit,
    path: '/users-intelligence',
  },
  {
    id: 'device-registry',
    label: 'Device Registry',
    icon: HardDrive,
    path: '/device-registry',
  },
  { id: 'notifications', label: 'Notifications', icon: Bell, path: '/notifications' },
  { id: 'sms-center', label: 'SMS Center', icon: MessageSquare, path: '/sms-center' },
  { id: 'payment-providers', label: 'Payment Providers', icon: Building2, path: '/payment-providers' },
  { id: 'analytics', label: 'Analytics', icon: BarChart3, path: '/analytics' },
  { id: 'zenopay', label: 'ZenoPay Settings', icon: WalletCards, path: '/zenopay' },
  { id: 'sonicpesa', label: 'SonicPesa Settings', icon: Landmark, path: '/sonicpesa' },
  { id: 'auraxpay', label: 'Aurax Pay Settings', icon: CircleDollarSign, path: '/auraxpay' },
  { id: 'whatsapp', label: 'WhatsApp Support', icon: MessageCircle, path: '/whatsapp' },
  { id: 'app-update', label: 'App Update', icon: Download, path: '/app-update' },
  { id: 'server-health', label: 'Server Health', icon: Server, path: '/server-health' },
  { id: 'popup', label: 'Popup Settings', icon: PanelTopOpen, path: '/popup-settings' },
  { id: 'device', label: 'Device Control', icon: TabletSmartphone, path: '/device-control' },
  { id: 'trial-watch', label: 'Trial Watch', icon: Clock, path: '/trial-watch' },
  { id: 'security', label: 'Security Center', icon: ShieldAlert, path: '/security' },
  { id: 'transfer', label: 'Transfer Codes', icon: KeyRound, path: '/transfer-codes' },
]

const itemButtonClass = (active) =>
  [
    'group flex w-full shrink-0 items-center gap-3 rounded-2xl px-4 py-3 text-left text-sm font-medium transition-all duration-300',
    active
      ? 'bg-gradient-to-r from-amber-300 to-yellow-500 text-slate-950 shadow-[0_10px_25px_rgba(251,191,36,0.35)]'
      : 'text-slate-300 hover:scale-[1.01] hover:bg-slate-800/70 hover:text-white',
  ].join(' ')

function Sidebar() {
  const navigate = useNavigate()
  const { panelAuthRequired, logout } = useAdminAuth()

  const panelSecurityItem = panelAuthRequired
    ? [
        {
          id: 'admin-panel-security',
          label: 'Admin Security',
          icon: ShieldCheck,
          path: '/admin-security',
        },
      ]
    : []

  const navItems = [...menuItems, ...panelSecurityItem]

  function handleLogout() {
    logout()
    if (panelAuthRequired) navigate('/login', { replace: true })
  }

  return (
    <aside className="fixed left-0 top-0 z-30 flex h-screen w-[280px] flex-col border-r border-slate-800/70 bg-[#0F172A] px-5 pb-6 pt-7">
      <NavLink
        to="/"
        className="mb-5 shrink-0 rounded-2xl border border-slate-700/50 bg-slate-800/40 px-4 py-3 shadow-[0_10px_30px_rgba(0,0,0,0.25)] transition-opacity hover:opacity-95"
      >
        <p className="text-xs uppercase tracking-[0.3em] text-slate-400">Streaming</p>
        <h1 className="mt-1 text-2xl font-bold text-white">Osmani TV</h1>
      </NavLink>

      <nav
        className="custom-scrollbar min-h-0 flex-1 space-y-1.5 overflow-y-auto overflow-x-hidden py-1 pr-1"
        aria-label="Main navigation"
      >
        {navItems.map((item) => {
          const Icon = item.icon
          if (item.path) {
            return (
              <NavLink
                key={item.id}
                to={item.path}
                end={item.path === '/'}
                className={({ isActive }) => itemButtonClass(isActive)}
              >
                <Icon className="h-5 w-5 shrink-0" aria-hidden />
                <span className="truncate">{item.label}</span>
              </NavLink>
            )
          }
          return (
            <button
              key={item.id}
              type="button"
              className={itemButtonClass(false)}
            >
              <Icon className="h-5 w-5 shrink-0" aria-hidden />
              <span className="truncate">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="mt-4 shrink-0 space-y-2 border-t border-slate-800/80 pt-4">
        <button
          type="button"
          className="flex w-full items-center gap-3 rounded-2xl bg-slate-800/60 px-4 py-3 text-sm font-medium text-slate-200 transition-all duration-300 hover:scale-[1.01] hover:bg-slate-700/80"
        >
          <PanelLeftClose className="h-5 w-5 shrink-0" />
          <span>Collapse</span>
        </button>
        <button
          type="button"
          onClick={handleLogout}
          className="flex w-full items-center gap-3 rounded-2xl bg-red-500/20 px-4 py-3 text-sm font-medium text-red-200 transition-all duration-300 hover:scale-[1.01] hover:bg-red-500/30"
        >
          <LogOut className="h-5 w-5 shrink-0" />
          <span>{panelAuthRequired ? 'Logout' : 'Clear session'}</span>
        </button>
      </div>
    </aside>
  )
}

export default Sidebar
