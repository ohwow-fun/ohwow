import { motion } from 'framer-motion';

interface Tab {
  id: string;
  label: string;
  count?: number;
}

interface TabSwitcherProps {
  tabs: Tab[];
  activeTab: string;
  onTabChange: (id: string) => void;
  layoutId?: string;
}

export function TabSwitcher({ tabs, activeTab, onTabChange, layoutId = 'tab-underline' }: TabSwitcherProps) {
  return (
    <div className="flex gap-1 border-b border-white/[0.08]">
      {tabs.map(tab => {
        const isActive = tab.id === activeTab;
        return (
          <button
            key={tab.id}
            onClick={() => onTabChange(tab.id)}
            className={`relative px-4 py-2.5 text-sm font-medium transition-colors ${
              isActive ? 'text-white' : 'text-neutral-400 hover:text-neutral-200'
            }`}
          >
            <span className="relative z-10 flex items-center gap-2">
              {tab.label}
              {tab.count != null && (
                <span className="text-[10px] bg-white/10 px-1.5 py-0.5 rounded-full min-w-[18px] text-center">
                  {tab.count}
                </span>
              )}
            </span>
            {isActive && (
              <motion.div
                layoutId={layoutId}
                className="absolute bottom-0 left-0 right-0 h-0.5 bg-white"
                transition={{ type: 'spring', stiffness: 350, damping: 30 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}
