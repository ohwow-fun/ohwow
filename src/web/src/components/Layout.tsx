import { useState, useEffect } from 'react';
import { Outlet, NavLink, useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useTier } from '../hooks/useTier';
import { useEventToasts } from '../hooks/useEventToasts';
import { ErrorBoundary } from './ErrorBoundary';
import { PageTransition } from './PageTransition';
import {
  GearSix,
  Kanban,
  BookOpen,
  List,
  X,
  CurrencyDollar,
  UsersThree,
  ChatCircle,
  Buildings,
  Pulse,
  ChartLine,
} from '@phosphor-icons/react';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

interface NavItem {
  path: string;
  label: string;
  icon: PhosphorIcon;
}

const NAV_ITEMS: NavItem[] = [
  { path: '/',             label: 'Pulse',        icon: Pulse },
  { path: '/chat',         label: 'Chat',         icon: ChatCircle },
  { path: '/portfolio',    label: 'Businesses',   icon: Buildings },
  { path: '/work',         label: 'Work',         icon: Kanban },
  { path: '/people',       label: 'People',       icon: UsersThree },
  { path: '/intelligence', label: 'Intelligence', icon: ChartLine },
  { path: '/knowledge',    label: 'Knowledge',    icon: BookOpen },
  { path: '/growth',       label: 'Growth',       icon: CurrencyDollar },
  { path: '/control-room', label: 'Control Room', icon: GearSix },
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
      <nav className="flex-1 overflow-y-auto p-3 space-y-0.5">
        {visibleNav.map(item => (
          <SidebarNavLink
            key={item.path}
            path={item.path}
            label={item.label}
            icon={item.icon}
            isActive={isActive(item.path)}
          />
        ))}
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
