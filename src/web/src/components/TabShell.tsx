import React from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';

export interface TabDef {
  slug: string;
  label: string;
  icon?: React.ComponentType<{ size?: number; weight?: string }>;
  badge?: number;
  hidden?: boolean;
}

export function useTabParam(defaultTab: string): [string, (tab: string) => void] {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();

  const activeTab = searchParams.get('tab') ?? defaultTab;

  const setTab = (tab: string) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('tab', tab);
    navigate({ search: `?${params.toString()}` }, { replace: true });
  };

  return [activeTab, setTab];
}

interface TabShellProps {
  tabs: TabDef[];
  children: (activeTab: string) => React.ReactNode;
  pageId: string;
}

export function TabShell({ tabs, children, pageId }: TabShellProps) {
  const visibleTabs = tabs.filter((t) => !t.hidden);
  const defaultTab = visibleTabs[0]?.slug ?? '';
  const [activeTab, setTab] = useTabParam(defaultTab);

  return (
    <div className="flex flex-col min-h-0">
      <div className="border-b border-white/10">
        <nav className="flex overflow-x-auto scrollbar-none">
          {visibleTabs.map((tab) => {
            const isActive = tab.slug === activeTab;
            const Icon = tab.icon;

            return (
              <button
                key={tab.slug}
                onClick={() => setTab(tab.slug)}
                className={[
                  'relative flex items-center gap-1.5 px-4 py-3 text-sm font-medium whitespace-nowrap transition-colors',
                  isActive ? 'text-white' : 'text-neutral-400 hover:text-white',
                ].join(' ')}
              >
                {Icon && <Icon size={14} />}
                {tab.label}
                {tab.badge != null && tab.badge > 0 && (
                  <span className="text-[10px] bg-warning/20 text-warning px-1.5 py-0.5 rounded-full font-bold">
                    {tab.badge}
                  </span>
                )}
                {isActive && (
                  <motion.div
                    layoutId={`tab-underline-${pageId}`}
                    className="absolute bottom-0 left-0 right-0 h-0.5 bg-white"
                  />
                )}
              </button>
            );
          })}
        </nav>
      </div>
      {children(activeTab)}
    </div>
  );
}
