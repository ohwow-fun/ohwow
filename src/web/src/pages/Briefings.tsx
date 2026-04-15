import { useMemo } from 'react';
import { Newspaper, Lightbulb, Clock, Robot } from '@phosphor-icons/react';
import { motion } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { RowSkeleton } from '../components/Skeleton';
import { FeatureIntro } from '../components/FeatureIntro';

interface ActivityEntry {
  id: string;
  activity_type: string;
  title: string;
  description: string | null;
  agent_id: string | null;
  created_at: string;
}

function timeAgo(dateStr: string): string {
  const d = /Z$|[+-]\d\d:?\d\d$/.test(dateStr) ? new Date(dateStr) : new Date(dateStr.replace(' ', 'T') + 'Z');
  const diff = Date.now() - d.getTime();
  if (diff < 0) return 'just now';
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

const BRIEFING_TYPES = ['briefing', 'suggestion', 'insight', 'anomaly', 'proactive'];

export function BriefingsPage() {
  const { data: activity, loading } = useApi<ActivityEntry[]>('/api/activity');

  const briefings = useMemo(() => {
    if (!activity) return [];
    return activity.filter(a =>
      BRIEFING_TYPES.some(t => (a.activity_type ?? '').toLowerCase().includes(t))
    );
  }, [activity]);

  // Also show recent completed tasks as "daily digest" items
  const recentCompleted = useMemo(() => {
    if (!activity) return [];
    return activity
      .filter(a => a.activity_type === 'task_completed')
      .slice(0, 10);
  }, [activity]);

  const isEmpty = !loading && briefings.length === 0 && recentCompleted.length === 0;

  return (
    <div className="p-6 max-w-4xl">
      <PageHeader title="Briefings" subtitle="Agent insights and daily digest" />

      {loading ? (
        <RowSkeleton count={4} />
      ) : isEmpty ? (
        <FeatureIntro
          icon={Newspaper}
          title="No briefings yet"
          description="Briefings appear here as your agents generate insights, detect anomalies, and complete work."
          capabilities={[
            { icon: Newspaper, label: 'Daily digest', description: 'Summary of completed work' },
            { icon: Lightbulb, label: 'Suggestions', description: 'Agent improvement ideas' },
            { icon: Robot, label: 'Proactive insights', description: 'Anomalies and opportunities' },
          ]}
        />
      ) : (
        <div className="space-y-6">
          {/* Briefings / Insights */}
          {briefings.length > 0 && (
            <div>
              <h3 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-3">Insights</h3>
              <div className="space-y-2">
                {briefings.map((item, i) => (
                  <motion.div
                    key={item.id}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: i * 0.04 }}
                    className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-4"
                  >
                    <div className="flex items-start gap-3">
                      <div className="w-8 h-8 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0 mt-0.5">
                        <Lightbulb size={16} className="text-amber-400" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <p className="text-sm font-medium">{item.title}</p>
                          <span className="text-[10px] bg-white/[0.06] px-1.5 py-0.5 rounded text-neutral-400">{item.activity_type}</span>
                        </div>
                        {item.description && <p className="text-xs text-neutral-400">{item.description}</p>}
                        <p className="text-[10px] text-neutral-500 mt-1.5 flex items-center gap-1">
                          <Clock size={10} /> {timeAgo(item.created_at)}
                        </p>
                      </div>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          )}

          {/* Recent completed tasks as digest */}
          {recentCompleted.length > 0 && (
            <div>
              <h3 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider mb-3">Recent completions</h3>
              <div className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
                {recentCompleted.map(item => (
                  <div key={item.id} className="flex items-center justify-between px-4 py-3">
                    <div className="min-w-0 mr-3">
                      <p className="text-sm font-medium truncate">{item.title}</p>
                      {item.description && <p className="text-xs text-neutral-400 truncate">{item.description}</p>}
                    </div>
                    <span className="text-xs text-neutral-500 shrink-0">{timeAgo(item.created_at)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
