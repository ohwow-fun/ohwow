import { useApi } from '../../hooks/useApi';

export interface HealthData {
  status: string;
  uptime: number;
  version: string;
  database: string;
}

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

export function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

export function RuntimeSection() {
  const { data: health } = useApi<HealthData>('/health');
  const { data: stats } = useApi<SystemStats>('/api/system/stats');

  return (
    <>
      {health && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Runtime</h2>
          <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
            <InfoRow label="Status" value={health.status} valueColor={health.status === 'healthy' ? 'text-success' : 'text-warning'} />
            <InfoRow label="Version" value={`v${health.version}`} />
            <InfoRow label="Uptime" value={formatUptime(health.uptime)} />
            <InfoRow label="Database" value={health.database} />
            {stats && <InfoRow label="Memory" value={`${stats.memoryMb} MB`} />}
          </div>
        </div>
      )}

      {stats && (
        <div className="mb-6">
          <h2 className="text-sm font-medium text-neutral-400 uppercase tracking-wider mb-3">Stats</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <StatCard label="Agents" value={String(stats.totalAgents)} />
            <StatCard label="Tasks" value={String(stats.totalTasks)} />
            <StatCard label="Tokens" value={stats.totalTokens.toLocaleString()} />
            <StatCard label="Cost" value={`$${(stats.totalCostCents / 100).toFixed(2)}`} />
          </div>
        </div>
      )}
    </>
  );
}

export function InfoRow({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div className="flex items-center justify-between px-4 py-3">
      <span className="text-sm text-neutral-400">{label}</span>
      <span className={`text-sm font-medium ${valueColor || ''}`}>{value}</span>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white/5 border border-white/[0.08] rounded-lg p-3">
      <p className="text-xs text-neutral-400">{label}</p>
      <p className="text-lg font-bold">{value}</p>
    </div>
  );
}
