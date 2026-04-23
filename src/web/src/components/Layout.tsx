import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTier } from '../hooks/useTier';
import { useEventToasts } from '../hooks/useEventToasts';
import { ErrorBoundary } from './ErrorBoundary';
import { PageTransition } from './PageTransition';
import {
  SquaresFour,
  Robot,
  ListChecks,
  ShieldCheck,
  Pulse,
  CalendarBlank,
  ChatCircle,
  GearSix,
  Kanban,
  Lightning,
  PlugsConnected,
  BookOpen,
  List,
  X,
  Cube,
  FlowArrow,
  Plug,
  Target,
  CurrencyDollar,
  ChatCircleDots,
  ShareNetwork,
  UsersThree,
  Browser,
  Newspaper,
  Microphone,
  Eye,
  Megaphone,
  ChatsCircle,
  Buildings,
  Gauge,
  CaretDown,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

interface NavItem {
  path: string;
  label: string;
  icon: PhosphorIcon;
  group: 'primary' | 'command' | 'studio' | 'knowledge' | 'people' | 'growth' | 'control_room';
}

const NAV_ITEMS: NavItem[] = [
  // Pinned
  { path: '/', label: 'Pulse', icon: Pulse, group: 'primary' },
  { path: '/chat', label: 'Chat', icon: ChatCircle, group: 'primary' },
  { path: '/portfolio', label: 'Businesses', icon: Buildings, group: 'primary' },
  // Command
  { path: '/dashboard', label: 'Overview', icon: SquaresFour, group: 'command' },
  { path: '/activity', label: 'Activity', icon: Lightning, group: 'command' },
  { path: '/messages', label: 'Messages', icon: ChatCircleDots, group: 'command' },
  { path: '/approvals', label: 'Approvals', icon: ShieldCheck, group: 'command' },
  // Studio
  { path: '/tasks', label: 'Tasks', icon: ListChecks, group: 'studio' },
  { path: '/projects', label: 'Projects', icon: Kanban, group: 'studio' },
  { path: '/agents', label: 'Agents', icon: Robot, group: 'studio' },
  { path: '/workflows', label: 'Workflows', icon: FlowArrow, group: 'studio' },
  { path: '/automations', label: 'Automations', icon: Lightning, group: 'studio' },
  { path: '/schedules', label: 'Schedules', icon: CalendarBlank, group: 'studio' },
  { path: '/templates', label: 'Templates', icon: Cube, group: 'studio' },
  // Knowledge
  { path: '/knowledge', label: 'Knowledge', icon: BookOpen, group: 'knowledge' },
  { path: '/briefings', label: 'Briefings', icon: Newspaper, group: 'knowledge' },
  { path: '/podcast', label: 'Podcast', icon: Microphone, group: 'knowledge' },
  // People
  { path: '/team', label: 'Team', icon: UsersThree, group: 'people' },
  { path: '/peers', label: 'Peers', icon: ShareNetwork, group: 'people' },
  { path: '/connections', label: 'Connections', icon: PlugsConnected, group: 'people' },
  { path: '/messaging', label: 'Messaging', icon: ChatCircleDots, group: 'people' },
  // Growth
  { path: '/goals', label: 'Goals', icon: Target, group: 'growth' },
  { path: '/revenue', label: 'Revenue', icon: CurrencyDollar, group: 'growth' },
  { path: '/marketing', label: 'Marketing', icon: Megaphone, group: 'growth' },
  { path: '/social', label: 'Social', icon: ChatsCircle, group: 'growth' },
  // Control Room
  { path: '/webhook-events', label: 'Webhooks', icon: Plug, group: 'control_room' },
  { path: '/browser', label: 'Browser', icon: Browser, group: 'control_room' },
  { path: '/eye', label: 'Eye', icon: Eye, group: 'control_room' },
  { path: '/settings', label: 'Settings', icon: GearSix, group: 'control_room' },
];

interface HealthData {
  status: string;
  uptime: number;
  version: string;
}

function formatUptime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function NavGroup({
  label,
  groupKey,
  icon: Icon,
  accentColor,
  children,
}: {
  label: string;
  groupKey: string;
  icon: PhosphorIcon;
  accentColor: string;
  children: React.ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div>
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center justify-between w-full px-3 mb-1 group cursor-pointer"
      >
        <div className="flex items-center gap-2">
          <span className={`transition-colors ${collapsed ? 'text-neutral-600' : accentColor}`}>
            <Icon size={14} weight="bold" />
          </span>
          <p className="text-[11px] font-medium tracking-wide text-neutral-500 group-hover:text-neutral-400 transition-colors">
            {label}
          </p>
        </div>
        <motion.span
          animate={{ rotate: collapsed ? -90 : 0 }}
          transition={{ duration: 0.15 }}
          className="text-neutral-600 group-hover:text-neutral-400 transition-colors"
        >
          <CaretDown size={10} weight="bold" />
        </motion.span>
      </button>
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="overflow-hidden"
          >
            <div className="space-y-0.5">{children}</div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SidebarNavLink({
  path,
  label,
  icon: Icon,
  isActive,
}: {
  path: string;
  label: string;
  icon: PhosphorIcon;
  isActive: boolean;
}) {
  return (
    <NavLink
      to={path}
      data-testid={`runtime-nav-${label.toLowerCase()}`}
      className={`relative flex items-center gap-3 px-3 py-2 text-sm rounded-md transition-colors ${
        isActive
          ? 'text-white'
          : 'text-neutral-400 hover:text-white hover:bg-white/5'
      }`}
    >
      {isActive && (
        <motion.div
          layoutId="sidebar-active"
          className="absolute inset-0 bg-white/10 rounded-md"
          transition={{ type: 'spring', stiffness: 350, damping: 30 }}
        />
      )}
      <span className="relative z-10 flex items-center gap-3">
        <Icon size={16} weight="bold" />
        {label}
      </span>
    </NavLink>
  );
}

function SidebarContent({
  health,
  healthError,
  healthLoading,
  tier,
  tierLoading,
  visibleNav,
  pathname,
  onClose,
}: {
  health: HealthData | null;
  healthError: string | null;
  healthLoading: boolean;
  tier: string;
  tierLoading: boolean;
  visibleNav: NavItem[];
  pathname: string;
  onClose?: () => void;
}) {
  const isActive = (path: string) =>
    path === '/'
      ? pathname === '/' || pathname === ''
      : pathname.startsWith(path);

  type DeptKey = NavItem['group'];
  const groups: { key: DeptKey; label?: string; icon?: PhosphorIcon; accentColor?: string }[] = [
    { key: 'primary' },
    { key: 'command', label: 'Command', icon: Gauge, accentColor: 'text-amber-400' },
    { key: 'studio', label: 'Studio', icon: Kanban, accentColor: 'text-violet-400' },
    { key: 'knowledge', label: 'Knowledge', icon: BookOpen, accentColor: 'text-teal-400' },
    { key: 'people', label: 'People', icon: UsersThree, accentColor: 'text-sky-400' },
    { key: 'growth', label: 'Growth', icon: CurrencyDollar, accentColor: 'text-emerald-400' },
    { key: 'control_room', label: 'Control Room', icon: GearSix, accentColor: 'text-neutral-400' },
  ];

  const renderItems = (items: NavItem[]) =>
    items.map(item => (
      <SidebarNavLink
        key={item.path}
        path={item.path}
        label={item.label}
        icon={item.icon}
        isActive={isActive(item.path)}
      />
    ));

  return (
    <div className="flex flex-col h-full">
      {/* Logo */}
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <span className="text-sm uppercase tracking-widest">
          <span className="font-bold">OHWOW</span>
          <span className="font-light">.FUN</span>
        </span>
        {onClose && (
          <button onClick={onClose} className="text-neutral-400 hover:text-white transition-colors md:hidden">
            <X size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <nav className="flex-1 overflow-y-auto p-3 space-y-4">
        {groups.map(({ key, label, icon, accentColor }) => {
          const items = visibleNav.filter(item => item.group === key);
          if (items.length === 0) return null;
          if (!label || !icon || !accentColor) {
            return <div key={key} className="space-y-0.5">{renderItems(items)}</div>;
          }
          return (
            <NavGroup key={key} label={label} groupKey={key} icon={icon} accentColor={accentColor}>
              {renderItems(items)}
            </NavGroup>
          );
        })}
      </nav>

      {/* Footer */}
      <div className="p-3 border-t border-white/10">
        <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-white/[0.03]">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${
                healthError ? 'bg-warning' :
                health ? (health.status === 'healthy' ? 'bg-success' : 'bg-warning') :
                'bg-neutral-600 animate-pulse'
              }`} />
              <span className="text-xs text-neutral-400">
                {healthError ? 'Offline' : health ? `v${health.version}` : healthLoading ? 'Starting...' : 'Connecting...'}
              </span>
              {health && !healthError && (
                <>
                  <span className="text-white/10 text-xs">|</span>
                  <span className="text-xs text-neutral-500">{formatUptime(health.uptime)}</span>
                </>
              )}
            </div>
          </div>
          {!tierLoading && (
            <span data-testid="runtime-tier-badge" className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium ${
              tier === 'free'
                ? 'bg-cyan-500/15 text-cyan-400'
                : 'bg-success/15 text-success'
            }`}>
              {tier === 'free' ? 'Local' : 'Cloud'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function Layout() {
  const location = useLocation();
  // /health returns the object directly (no { data: } wrapper), so we can't use useApi here.
  const [health, setHealth] = useState<HealthData | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    fetch('/health')
      .then(r => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((d: HealthData) => { if (!cancelled) { setHealth(d); setHealthError(null); } })
      .catch((e: Error) => { if (!cancelled) setHealthError(e.message); })
      .finally(() => { if (!cancelled) setHealthLoading(false); });
    return () => { cancelled = true; };
  }, []);
  const { tier, modelReady, loading: tierLoading } = useTier();
  useEventToasts();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(() => {
    try { return localStorage.getItem('ohwow-model-banner-dismissed') === '1'; } catch { return false; }
  });

  // Close mobile sidebar on navigation
  // eslint-disable-next-line react-hooks/set-state-in-effect -- synchronizing UI state with route changes
  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  const showModelBanner = !tierLoading && !modelReady && !bannerDismissed;
  const dismissBanner = () => {
    setBannerDismissed(true);
    try { localStorage.setItem('ohwow-model-banner-dismissed', '1'); } catch { /* */ }
  };

  const visibleNav = NAV_ITEMS;

  return (
    <div className="flex h-dvh bg-black text-white">
      {/* Desktop Sidebar */}
      <aside className="hidden md:flex w-64 border-r border-white/10 flex-col h-dvh sticky top-0">
        <SidebarContent
          health={health ?? null}
          healthError={healthError}
          healthLoading={healthLoading}
          tier={tier}
          tierLoading={tierLoading}
          visibleNav={visibleNav}
          pathname={location.pathname}
        />
      </aside>

      {/* Mobile Sidebar */}
      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setMobileOpen(false)}
              className="fixed inset-0 bg-black/60 z-40 md:hidden"
            />
            <motion.aside
              initial={{ x: -280 }}
              animate={{ x: 0 }}
              exit={{ x: -280 }}
              transition={{ type: 'spring', stiffness: 350, damping: 30 }}
              className="fixed inset-y-0 left-0 w-[280px] bg-black border-r border-white/10 z-50 md:hidden"
            >
              <SidebarContent
                health={health ?? null}
                healthError={healthError}
                healthLoading={healthLoading}
                tier={tier}
                tierLoading={tierLoading}
                visibleNav={visibleNav}
                pathname={location.pathname}
                onClose={() => setMobileOpen(false)}
              />
            </motion.aside>
          </>
        )}
      </AnimatePresence>

      {/* Main content */}
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        {/* Mobile header */}
        <div className="md:hidden flex items-center gap-3 px-4 py-3 border-b border-white/10">
          <button
            onClick={() => setMobileOpen(true)}
            className="text-neutral-400 hover:text-white transition-colors"
          >
            <List size={20} />
          </button>
          <span className="text-sm uppercase tracking-widest">
            <span className="font-bold">OHWOW</span>
            <span className="font-light">.FUN</span>
          </span>
        </div>

        <main className="flex-1 overflow-y-auto min-h-0">
          {showModelBanner && (
            <div className="bg-warning/10 border-b border-warning/20 px-6 py-2.5 flex items-center justify-between">
              <p className="text-sm text-warning">
                No AI model set up yet. Head to{' '}
                <NavLink to="/settings" className="underline hover:text-white">Settings</NavLink>
                {' '}to download one.
              </p>
              <button
                onClick={dismissBanner}
                className="text-warning/60 hover:text-warning text-sm ml-4"
                aria-label="Dismiss"
              >
                ✕
              </button>
            </div>
          )}
          <ErrorBoundary>
            <PageTransition key={location.pathname}>
              <Outlet />
            </PageTransition>
          </ErrorBoundary>
        </main>
      </div>
    </div>
  );
}
