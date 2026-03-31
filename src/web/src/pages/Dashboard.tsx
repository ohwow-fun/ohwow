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

interface ActivityEntry {
  type: string;
  created_at: string;
}

interface DayBucket {
  label: string;
  completed: number;
  failed: number;
}

function buildDayBuckets(entries: ActivityEntry[]): DayBucket[] {
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const buckets: DayBucket[] = [];
  const now = new Date();

  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    buckets.push({
      label: dayNames[d.getDay()],
      completed: 0,
      failed: 0,
    });
  }

  for (const entry of entries) {
    const entryDate = new Date(entry.created_at);
    const diffMs = now.getTime() - entryDate.getTime();
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (diffDays < 0 || diffDays > 6) continue;
    const bucketIdx = 6 - diffDays;
    if (entry.type === 'task_completed') buckets[bucketIdx].completed++;
    if (entry.type === 'task_failed') buckets[bucketIdx].failed++;
  }

  return buckets;
}

function TaskActivityChart({ activity }: { activity: ActivityEntry[] | null }) {
  const buckets = activity ? buildDayBuckets(activity) : [];
  const maxVal = Math.max(1, ...buckets.map(b => b.completed + b.failed));
  const barWidth = 28;
  const gap = 12;
  const chartHeight = 80;
  const svgWidth = buckets.length * (barWidth + gap) - gap;

  if (!activity) {
    return (
      <div className="border border-white/[0.08] rounded-lg p-4 mb-8">
        <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-3">Task Activity (7 days)</p>
        <div className="h-[100px] flex items-center justify-center">
          <p className="text-xs text-neutral-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="border border-white/[0.08] rounded-lg p-4 mb-8">
      <p className="text-[11px] text-neutral-500 uppercase tracking-wider mb-3">Task Activity (7 days)</p>
      <div className="flex justify-center">
        <svg width={svgWidth} height={chartHeight + 20} className="overflow-visible">
          {buckets.map((bucket, i) => {
            const x = i * (barWidth + gap);
            const totalHeight = ((bucket.completed + bucket.failed) / maxVal) * chartHeight;
            const completedHeight = (bucket.completed / maxVal) * chartHeight;
            const failedHeight = (bucket.failed / maxVal) * chartHeight;

            return (
              <g key={i}>
                {/* Background track */}
                <rect
                  x={x}
                  y={0}
                  width={barWidth}
                  height={chartHeight}
                  rx={4}
                  className="fill-white/[0.03]"
                />
                {/* Completed bar */}
                {bucket.completed > 0 && (
                  <rect
                    x={x}
                    y={chartHeight - totalHeight}
                    width={barWidth}
                    height={completedHeight}
                    rx={4}
                    className="fill-success/60"
                  />
                )}
                {/* Failed bar (stacked on top) */}
                {bucket.failed > 0 && (
                  <rect
                    x={x}
                    y={chartHeight - failedHeight}
                    width={barWidth}
                    height={failedHeight}
                    rx={4}
                    className="fill-critical/60"
                  />
                )}
                {/* Day label */}
                <text
                  x={x + barWidth / 2}
                  y={chartHeight + 14}
                  textAnchor="middle"
                  className="fill-neutral-500 text-[10px]"
                >
                  {bucket.label}
                </text>
                {/* Count label on bar */}
                {(bucket.completed + bucket.failed) > 0 && (
                  <text
                    x={x + barWidth / 2}
                    y={chartHeight - totalHeight - 4}
                    textAnchor="middle"
                    className="fill-neutral-400 text-[10px]"
                  >
                    {bucket.completed + bucket.failed}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <div className="flex items-center gap-4 mt-3 justify-center">
        <span className="flex items-center gap-1.5 text-[10px] text-neutral-500">
          <span className="inline-block w-2 h-2 rounded-sm bg-success/60" /> Completed
        </span>
        <span className="flex items-center gap-1.5 text-[10px] text-neutral-500">
          <span className="inline-block w-2 h-2 rounded-sm bg-critical/60" /> Failed
        </span>
      </div>
    </div>
  );
}

function QuickStatsRow({ agents, tasks }: { agents: Agent[] | null; tasks: Task[] | null }) {
  const activeAgents = agents ? agents.filter(a => a.status !== 'paused').length : 0;

  const todayStr = new Date().toISOString().slice(0, 10);
  const todayTasks = tasks
    ? tasks.filter(t => t.status === 'completed' && t.created_at.startsWith(todayStr)).length
    : 0;

  const completed = tasks ? tasks.filter(t => t.status === 'completed').length : 0;
  const failed = tasks ? tasks.filter(t => t.status === 'failed').length : 0;
  const successRate = completed + failed > 0 ? Math.round((completed / (completed + failed)) * 100) : 100;

  return (
    <div className="flex gap-3 mb-8">
      <div className="flex-1 border border-white/[0.06] rounded-lg px-4 py-3 bg-white/[0.02]">
        <p className="text-[10px] text-neutral-500 uppercase tracking-wider">Active Agents</p>
        <p className="text-lg font-semibold text-success mt-0.5">{activeAgents}</p>
      </div>
      <div className="flex-1 border border-white/[0.06] rounded-lg px-4 py-3 bg-white/[0.02]">
        <p className="text-[10px] text-neutral-500 uppercase tracking-wider">Completed Today</p>
        <p className="text-lg font-semibold text-white mt-0.5">{todayTasks}</p>
      </div>
      <div className="flex-1 border border-white/[0.06] rounded-lg px-4 py-3 bg-white/[0.02]">
        <p className="text-[10px] text-neutral-500 uppercase tracking-wider">Success Rate</p>
        <p className={`text-lg font-semibold mt-0.5 ${successRate >= 80 ? 'text-success' : successRate >= 50 ? 'text-warning' : 'text-critical'}`}>
          {successRate}%
        </p>
      </div>
    </div>
  );
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
  const { data: activity } = useApi<ActivityEntry[]>('/api/activity', [wsTick]);

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

      {/* Task activity chart */}
      <TaskActivityChart activity={activity} />

      {/* Quick stats */}
      <QuickStatsRow agents={agents} tasks={tasks} />

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
