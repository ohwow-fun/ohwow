import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useApi } from '../hooks/useApi';
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
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

interface NavItem {
  path: string;
  label: string;
  icon: PhosphorIcon;
  group: 'primary' | 'manage' | 'connect' | 'configure';
}

const NAV_ITEMS: NavItem[] = [
  // Primary (unlabeled)
  { path: '/', label: 'Chat', icon: ChatCircle, group: 'primary' },
  { path: '/dashboard', label: 'Overview', icon: SquaresFour, group: 'primary' },
  { path: '/tasks', label: 'Tasks', icon: ListChecks, group: 'primary' },
  { path: '/activity', label: 'Activity', icon: Pulse, group: 'primary' },
  { path: '/messages', label: 'Messages', icon: ChatCircle, group: 'primary' },
  // Manage
  { path: '/agents', label: 'Agents', icon: Robot, group: 'manage' },
  { path: '/projects', label: 'Projects', icon: Kanban, group: 'manage' },
  { path: '/workflows', label: 'Workflows', icon: FlowArrow, group: 'manage' },
  { path: '/automations', label: 'Automations', icon: Lightning, group: 'manage' },
  { path: '/templates', label: 'Templates', icon: Cube, group: 'manage' },
  { path: '/schedules', label: 'Schedules', icon: CalendarBlank, group: 'manage' },
  { path: '/approvals', label: 'Approvals', icon: ShieldCheck, group: 'manage' },
  { path: '/goals', label: 'Goals', icon: Target, group: 'manage' },
  { path: '/revenue', label: 'Revenue', icon: CurrencyDollar, group: 'manage' },
  // Connect
  { path: '/messaging', label: 'Messaging', icon: ChatCircleDots, group: 'connect' },
  { path: '/peers', label: 'Peers', icon: ShareNetwork, group: 'connect' },
  { path: '/team', label: 'Team', icon: UsersThree, group: 'connect' },
  { path: '/connections', label: 'Connections', icon: PlugsConnected, group: 'connect' },
  // Configure
  { path: '/webhook-events', label: 'Webhooks', icon: Plug, group: 'configure' },
  { path: '/browser', label: 'Browser', icon: Browser, group: 'configure' },
  { path: '/briefings', label: 'Briefings', icon: Newspaper, group: 'configure' },
  { path: '/podcast', label: 'Podcast', icon: Microphone, group: 'configure' },
  { path: '/knowledge', label: 'Knowledge', icon: BookOpen, group: 'configure' },
  { path: '/settings', label: 'Settings', icon: GearSix, group: 'configure' },
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

function NavGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[10px] uppercase tracking-widest text-neutral-600 px-3 mb-1.5">{label}</p>
      <div className="space-y-0.5">{children}</div>
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
  tier,
  tierLoading,
  visibleNav,
  pathname,
  onClose,
}: {
  health: HealthData | null;
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

  const groups: { key: NavItem['group']; label?: string }[] = [
    { key: 'primary' },
    { key: 'manage', label: 'Manage' },
    { key: 'connect', label: 'Connect' },
    { key: 'configure', label: 'Configure' },
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
      <nav className="flex-1 overflow-y-auto p-3 space-y-5">
        {groups.map(({ key, label }) => {
          const items = visibleNav.filter(item => item.group === key);
          if (items.length === 0) return null;
          if (!label) {
            return <div key={key} className="space-y-0.5">{renderItems(items)}</div>;
          }
          return (
            <NavGroup key={key} label={label}>
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
              {health && (
                <span className={`inline-block w-1.5 h-1.5 rounded-full ${health.status === 'healthy' ? 'bg-success' : 'bg-warning'}`} />
              )}
              <span className="text-xs text-neutral-400">
                {health ? `v${health.version}` : 'Starting...'}
              </span>
              {health && (
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
  const { data: health } = useApi<HealthData>('/health');
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
