import { ReactNode } from 'react';
import { motion } from 'framer-motion';
import type { Icon as PhosphorIcon } from '@phosphor-icons/react';

interface Capability {
  icon: PhosphorIcon;
  label: string;
  description?: string;
}

interface FeatureIntroProps {
  icon: PhosphorIcon;
  title: string;
  description?: string;
  capabilities: Capability[];
  action?: {
    label: string;
    onClick?: () => void;
    href?: string;
  };
  variant?: 'full' | 'compact';
}

export function FeatureIntro({
  icon: Icon,
  title,
  description,
  capabilities,
  action,
  variant = 'full',
}: FeatureIntroProps) {
  if (variant === 'compact') {
    return (
      <div className="border border-white/[0.06] bg-white/[0.02] rounded-lg p-4 flex items-center gap-4">
        <div className="shrink-0 w-10 h-10 rounded-lg bg-white/[0.04] flex items-center justify-center">
          <Icon size={20} className="text-neutral-400" />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-neutral-300">{title}</p>
          <div className="flex gap-2 mt-1.5 flex-wrap">
            {capabilities.map((cap) => (
              <span
                key={cap.label}
                className="text-[10px] bg-white/[0.04] border border-white/[0.06] px-2 py-0.5 rounded-full text-neutral-500"
              >
                {cap.label}
              </span>
            ))}
          </div>
        </div>
        {action && (
          <button
            onClick={action.onClick}
            className="text-xs text-neutral-400 hover:text-white transition-colors shrink-0"
          >
            {action.label} →
          </button>
        )}
      </div>
    );
  }

  const cols =
    capabilities.length <= 2
      ? 'grid-cols-2'
      : capabilities.length === 3
      ? 'grid-cols-3'
      : 'grid-cols-2 md:grid-cols-4';

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3 }}
      className="border border-white/[0.06] bg-white/[0.02] rounded-lg py-12 px-6"
    >
      <div className="flex flex-col items-center text-center max-w-lg mx-auto">
        <div className="w-14 h-14 rounded-xl bg-white/[0.04] flex items-center justify-center mb-4">
          <Icon size={28} className="text-neutral-400" />
        </div>
        <h3 className="text-sm font-medium text-neutral-300">{title}</h3>
        {description && (
          <p className="text-xs text-neutral-500 mt-1.5 max-w-sm">{description}</p>
        )}
      </div>

      <div className={`grid ${cols} gap-3 mt-8 max-w-2xl mx-auto`}>
        {capabilities.map((cap, i) => (
          <motion.div
            key={cap.label}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0.05 * i }}
            className="border border-white/[0.06] bg-white/[0.02] rounded-lg p-3"
          >
            <cap.icon size={16} className="text-neutral-500 mb-2" />
            <p className="text-xs font-medium text-neutral-300">{cap.label}</p>
            {cap.description && (
              <p className="text-[10px] text-neutral-500 mt-0.5">{cap.description}</p>
            )}
          </motion.div>
        ))}
      </div>

      {action && (
        <div className="flex justify-center mt-6">
          <button
            onClick={action.onClick}
            className="px-4 py-2 text-sm font-medium bg-white text-black rounded-md hover:bg-neutral-200 transition-colors"
          >
            {action.label}
          </button>
        </div>
      )}
    </motion.div>
  );
}
