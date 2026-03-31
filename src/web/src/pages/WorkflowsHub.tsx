import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { CalendarBlank, Lightning, ArrowRight, Timer, ClockCounterClockwise, Plug, GitBranch } from '@phosphor-icons/react';
import { PageHeader } from '../components/PageHeader';

const cards = [
  {
    to: '/schedules',
    icon: CalendarBlank,
    color: 'blue',
    title: 'Schedules',
    description: 'Set up recurring tasks on a cron schedule. Agents run automatically at the times you define.',
    features: [
      { icon: Timer, label: 'Cron expressions' },
      { icon: ClockCounterClockwise, label: 'Run history' },
    ],
  },
  {
    to: '/automations',
    icon: Lightning,
    color: 'amber',
    title: 'Automations',
    description: 'Build event-driven flows triggered by webhooks, schedules, or manual input. Chain multiple steps together.',
    features: [
      { icon: Plug, label: 'Webhook triggers' },
      { icon: GitBranch, label: 'Visual builder' },
    ],
  },
];

const colorMap: Record<string, { border: string; bg: string; iconBg: string }> = {
  blue: {
    border: 'border-blue-500/20 hover:border-blue-500/30',
    bg: 'hover:bg-blue-500/[0.03]',
    iconBg: 'bg-blue-500/10',
  },
  amber: {
    border: 'border-amber-500/20 hover:border-amber-500/30',
    bg: 'hover:bg-amber-500/[0.03]',
    iconBg: 'bg-amber-500/10',
  },
};

export function WorkflowsHub() {
  return (
    <div className="p-6 max-w-4xl">
      <PageHeader
        title="Workflows"
        subtitle="Automate recurring tasks and event-driven flows"
      />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {cards.map((card, i) => {
          const colors = colorMap[card.color];
          return (
            <motion.div
              key={card.to}
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.3, delay: i * 0.08 }}
            >
              <Link
                to={card.to}
                className={`block border ${colors.border} ${colors.bg} bg-white/[0.02] rounded-lg p-5 transition-all group`}
              >
                <div className="flex items-start justify-between mb-3">
                  <div className={`w-10 h-10 rounded-lg ${colors.iconBg} flex items-center justify-center`}>
                    <card.icon size={20} weight="bold" className="text-white" />
                  </div>
                  <ArrowRight
                    size={16}
                    className="text-neutral-500 group-hover:text-white group-hover:translate-x-0.5 transition-all"
                  />
                </div>
                <h3 className="text-sm font-semibold text-white mb-1">{card.title}</h3>
                <p className="text-xs text-neutral-400 mb-4 leading-relaxed">{card.description}</p>
                <div className="flex gap-2">
                  {card.features.map(f => (
                    <span
                      key={f.label}
                      className="inline-flex items-center gap-1 text-[10px] bg-white/[0.04] border border-white/[0.06] px-2 py-1 rounded-full text-neutral-400"
                    >
                      <f.icon size={10} />
                      {f.label}
                    </span>
                  ))}
                </div>
              </Link>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}
