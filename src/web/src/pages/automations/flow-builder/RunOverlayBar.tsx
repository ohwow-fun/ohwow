import { useState } from 'react';
import { Lightning, CaretDown, Check, X, Spinner, Clock } from '@phosphor-icons/react';
import type { AutomationRun } from '../types';

const STATUS_ICONS: Record<string, typeof Check> = {
  completed: Check,
  failed: X,
  running: Spinner,
  pending: Clock,
  cancelled: X,
};

const STATUS_COLORS: Record<string, string> = {
  completed: 'text-emerald-400',
  failed: 'text-red-400',
  running: 'text-blue-400',
  pending: 'text-neutral-400',
  cancelled: 'text-neutral-500',
};

function formatTimeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

interface RunOverlayBarProps {
  runs: AutomationRun[];
  selectedRun: AutomationRun | null;
  onSelectRun: (run: AutomationRun | null) => void;
  overlayEnabled: boolean;
  onToggleOverlay: (enabled: boolean) => void;
}

export function RunOverlayBar({
  runs,
  selectedRun,
  onSelectRun,
  overlayEnabled,
  onToggleOverlay,
}: RunOverlayBarProps) {
  const [dropdownOpen, setDropdownOpen] = useState(false);

  const displayRun = selectedRun || runs[0] || null;
  const hasRuns = runs.length > 0;

  return (
    <div className="absolute right-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-white/[0.08] bg-black/60 px-3 py-1.5 shadow-lg backdrop-blur-sm">
      <Lightning size={14} className="text-neutral-500" weight="fill" />

      {!hasRuns ? (
        <span className="text-[11px] text-neutral-600">No runs yet</span>
      ) : (
        <>
          {/* Toggle */}
          <button
            onClick={() => onToggleOverlay(!overlayEnabled)}
            className={`relative h-5 w-9 rounded-full transition-colors ${
              overlayEnabled ? 'bg-white/20' : 'bg-white/[0.06]'
            }`}
          >
            <div
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                overlayEnabled ? 'left-[18px]' : 'left-0.5'
              }`}
            />
          </button>

          {/* Run selector */}
          <div className="relative">
            <button
              onClick={() => setDropdownOpen(!dropdownOpen)}
              className="flex items-center gap-1.5 text-[11px] text-neutral-400 hover:text-neutral-300"
            >
              {displayRun && (() => {
                const StatusIcon = STATUS_ICONS[displayRun.status] || Clock;
                return (
                  <StatusIcon
                    size={12}
                    className={`${STATUS_COLORS[displayRun.status] || 'text-neutral-400'} ${
                      displayRun.status === 'running' ? 'animate-spin' : ''
                    }`}
                    weight={displayRun.status === 'running' ? 'bold' : 'fill'}
                  />
                );
              })()}
              <span>
                {displayRun
                  ? formatTimeAgo(displayRun.created_at)
                  : 'Select run'}
              </span>
              <CaretDown size={10} />
            </button>

            {dropdownOpen && (
              <>
                <div
                  className="fixed inset-0 z-10"
                  onClick={() => setDropdownOpen(false)}
                />
                <div className="absolute right-0 top-full z-20 mt-1 w-48 rounded-lg border border-white/[0.08] bg-black/80 py-1 shadow-xl backdrop-blur-sm">
                  {runs.slice(0, 8).map((run) => {
                    const StatusIcon = STATUS_ICONS[run.status] || Clock;
                    return (
                      <button
                        key={run.id}
                        onClick={() => {
                          onSelectRun(run);
                          onToggleOverlay(true);
                          setDropdownOpen(false);
                        }}
                        className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11px] hover:bg-white/[0.05] ${
                          selectedRun?.id === run.id ? 'bg-white/[0.05] text-white' : 'text-neutral-400'
                        }`}
                      >
                        <StatusIcon
                          size={11}
                          className={`${STATUS_COLORS[run.status]} ${
                            run.status === 'running' ? 'animate-spin' : ''
                          }`}
                          weight={run.status === 'running' ? 'bold' : 'fill'}
                        />
                        <span className="flex-1">{formatTimeAgo(run.created_at)}</span>
                        <span className="text-[10px] text-neutral-600">
                          {run.step_results?.length || 0}/{run.total_steps} steps
                        </span>
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
