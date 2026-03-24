const STATUS_STYLES: Record<string, string> = {
  idle: 'bg-white/5 text-neutral-400',
  working: 'bg-blue-500/15 text-blue-400',
  completed: 'bg-success/15 text-success',
  approved: 'bg-success/15 text-success',
  in_progress: 'bg-blue-500/15 text-blue-400',
  queued: 'bg-warning/15 text-warning',
  needs_approval: 'bg-warning/15 text-warning',
  failed: 'bg-critical/15 text-critical',
  rejected: 'bg-critical/15 text-critical',
  active: 'bg-success/15 text-success',
  paused: 'bg-warning/15 text-warning',
  disabled: 'bg-white/5 text-neutral-400',
  draft: 'bg-warning/15 text-warning',
  archived: 'bg-white/5 text-neutral-400',
  executing: 'bg-blue-500/15 text-blue-400',
  pending: 'bg-warning/15 text-warning',
  error: 'bg-critical/15 text-critical',
  suspended: 'bg-warning/15 text-warning',
  disconnected: 'bg-white/5 text-neutral-400',
  skipped: 'bg-white/5 text-neutral-400',
  read_only: 'bg-white/5 text-neutral-400',
  processed: 'bg-success/15 text-success',
};

export function StatusBadge({ status }: { status: string }) {
  const style = STATUS_STYLES[status] || 'bg-white/5 text-neutral-400';
  const label = status.replace(/_/g, ' ');

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium capitalize ${style}`}>
      {label}
    </span>
  );
}
