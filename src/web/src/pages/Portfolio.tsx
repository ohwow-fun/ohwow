import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import { PageHeader } from '../components/PageHeader';
import { EmptyState } from '../components/EmptyState';
import { Skeleton } from '../components/Skeleton';

interface WorkspaceEntry {
  name: string;
  displayName: string;
  mode: string;
  port: number | null;
  running: boolean;
  loaded: boolean;
  isActive: boolean;
}

function SkeletonCard() {
  return (
    <div className="border border-white/[0.08] rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-5 w-16 rounded" />
      </div>
      <div className="flex items-center gap-2">
        <Skeleton className="h-2 w-2 rounded-full" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="h-8 w-24 rounded" />
    </div>
  );
}

export function PortfolioPage() {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const { data: workspaces, loading } = useApi<WorkspaceEntry[]>('/api/workspaces', [tick]);

  return (
    <div className="p-6">
      <PageHeader
        title="Businesses"
        action={
          <Link
            to="/new-business"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-white/[0.06] hover:bg-white/[0.10] text-neutral-200 transition-colors"
          >
            + New Business
          </Link>
        }
      />

      {loading && !workspaces ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          <SkeletonCard />
          <SkeletonCard />
          <SkeletonCard />
        </div>
      ) : !workspaces || workspaces.length === 0 ? (
        <EmptyState
          title="No businesses yet."
          description="Each business runs its own AI team on its own port. Create one to get started."
          action={
            <Link
              to="/new-business"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium bg-white/[0.06] hover:bg-white/[0.10] text-neutral-200 transition-colors"
            >
              + New Business
            </Link>
          }
        />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {workspaces.map(ws => {
            const dashboardUrl = ws.port ? `http://localhost:${ws.port}/ui/` : null;
            return (
              <div
                key={ws.name}
                className="border border-white/[0.08] bg-white/[0.02] rounded-lg p-5 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-semibold text-neutral-100 leading-snug">
                    {ws.displayName}
                  </span>
                  <span className="shrink-0 inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-white/5 text-neutral-400 capitalize">
                    {ws.mode}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className={`inline-block h-2 w-2 rounded-full ${ws.running ? 'bg-green-500' : 'bg-neutral-600'}`} />
                  <span className="text-xs text-neutral-400">{ws.running ? 'Running' : 'Stopped'}</span>
                </div>
                <div className="mt-auto pt-1">
                  {ws.isActive ? (
                    <span className="text-xs font-medium text-green-400">You&apos;re here</span>
                  ) : dashboardUrl ? (
                    <a href={dashboardUrl} className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-medium bg-white/[0.06] hover:bg-white/[0.10] text-neutral-200 transition-colors">
                      Switch
                    </a>
                  ) : (
                    <span className="text-xs text-neutral-600">Not started</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
