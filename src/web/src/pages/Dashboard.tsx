import { Link } from 'react-router-dom';
import { motion } from 'framer-motion';
import { useApi } from '../hooks/useApi';
import { useWsRefresh } from '../hooks/useWebSocket';
import { MetricCard } from '../components/MetricCard';
import { StatusBadge } from '../components/StatusBadge';
import { CardSkeleton, RowSkeleton } from '../components/Skeleton';
import { PageHeader } from '../components/PageHeader';

interface SystemStats {
  uptime: number;
  memoryMb: number;
  totalAgents: number;
  totalTasks: number;
  activeTasks: number;
  pendingApprovals: number;
  totalTokens: number;
  totalCostCents: number;
}

interface Agent {
  id: string;
  name: string;
  role: string;
  status: string;
}

interface Task {
  id: string;
  title: string;
  status: string;
  agent_id: string;
  created_at: string;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(n);
}

const staggerContainer = {
  animate: { transition: { staggerChildren: 0.05 } },
};

const fadeInUp = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
};

export function DashboardPage() {
  const wsTick = useWsRefresh(['task:started', 'task:completed', 'task:failed']);
  const { data: stats, loading: statsLoading } = useApi<SystemStats>('/api/system/stats', [wsTick]);
  const { data: agents } = useApi<Agent[]>('/api/agents', [wsTick]);
  const { data: tasks } = useApi<Task[]>('/api/tasks?limit=5', [wsTick]);

  return (
    <div className="p-6 max-w-5xl">
      <PageHeader title="Overview" subtitle="Runtime at a glance" />

      {/* Stats strip */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-8">
        {statsLoading ? (
          <>
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
            <CardSkeleton />
          </>
        ) : stats ? (
          <>
            <MetricCard label="Agents" value={stats.totalAgents} />
            <MetricCard label="Tasks" value={stats.totalTasks} subtitle={`${stats.activeTasks} active`} />
            <MetricCard label="Approvals" value={stats.pendingApprovals} color={stats.pendingApprovals > 0 ? 'text-warning' : 'text-neutral-400'} />
            <MetricCard label="Tokens" value={formatTokens(stats.totalTokens)} subtitle={`$${(stats.totalCostCents / 100).toFixed(2)}`} />
          </>
        ) : null}
      </div>

      {/* Agent cards grid */}
      <div className="mb-8">
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Agents</h2>
          <Link to="/agents" className="text-xs text-neutral-400 hover:text-white transition-colors">View all</Link>
        </div>
        {agents?.length ? (
          <motion.div
            className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            {agents.slice(0, 8).map(agent => (
              <motion.div key={agent.id} variants={fadeInUp}>
                <Link
                  to={`/agents/${agent.id}`}
                  className="block border border-white/[0.08] rounded-lg p-4 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-white/10 flex items-center justify-center text-xs font-bold mb-3">
                    {agent.name[0]?.toUpperCase()}
                  </div>
                  <p className="text-sm font-medium truncate">{agent.name}</p>
                  <p className="text-xs text-neutral-500 truncate mt-0.5">{agent.role}</p>
                  <div className="mt-2">
                    <StatusBadge status={agent.status} />
                  </div>
                </Link>
              </motion.div>
            ))}
          </motion.div>
        ) : (
          <RowSkeleton count={2} />
        )}
      </div>

      {/* Recent tasks */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-[11px] font-medium text-neutral-500 uppercase tracking-wider">Recent Tasks</h2>
          <Link to="/tasks" className="text-xs text-neutral-400 hover:text-white transition-colors">View all</Link>
        </div>
        {tasks?.length ? (
          <motion.div
            className="border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]"
            variants={staggerContainer}
            initial="initial"
            animate="animate"
          >
            {tasks.map(task => (
              <motion.div key={task.id} variants={fadeInUp}>
                <Link
                  to={`/tasks/${task.id}`}
                  className="flex items-center justify-between px-4 py-3 hover:bg-white/[0.02] transition-colors"
                >
                  <div className="min-w-0 mr-3">
                    <p className="text-sm font-medium truncate">{task.title}</p>
                    <p className="text-xs text-neutral-500">{new Date(task.created_at).toLocaleString()}</p>
                  </div>
                  <StatusBadge status={task.status} />
                </Link>
              </motion.div>
            ))}
          </motion.div>
        ) : (
          <RowSkeleton count={3} />
        )}
      </div>
    </div>
  );
}
