import { CircleNotch, Trash, Star, Brain, Eject } from '@phosphor-icons/react';
import type { InstalledModel } from './model-types';

interface Props {
  models: InstalledModel[];
  downloading: { tag: string; percent: number; message: string } | null;
  onSetActive: (tag: string) => void;
  onSetOrchestrator: (tag: string) => void;
  onUnload: (tag: string) => void;
  onDelete: (tag: string) => void;
  onCancelDownload: () => void;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function FeatureBadge({ label, color }: { label: string; color: string }) {
  return (
    <span className={`inline-flex items-center gap-0.5 px-1.5 py-0.5 text-[10px] font-medium rounded ${color}`}>
      {label}
    </span>
  );
}

export function InstalledModelsList({ models, downloading, onSetActive, onSetOrchestrator, onUnload, onDelete, onCancelDownload }: Props) {
  if (models.length === 0 && !downloading) {
    return (
      <div className="bg-white/5 border border-white/[0.08] rounded-lg p-6 text-center">
        <p className="text-sm text-neutral-400 mb-1">No models installed yet</p>
        <p className="text-xs text-neutral-400/70">Browse the catalog below to install your first model</p>
      </div>
    );
  }

  return (
    <div className="bg-white/5 border border-white/[0.08] rounded-lg divide-y divide-white/[0.08]">
      {/* Show downloading model if not already in the installed list */}
      {downloading && !models.some(m => m.tag === downloading.tag) && (
        <div className="px-4 py-3">
          <div className="flex items-center justify-between">
            <span className="text-sm font-medium">{downloading.tag}</span>
            <div className="flex items-center gap-2">
              <CircleNotch size={14} className="animate-spin text-white" />
              <span className="text-xs text-neutral-400">{downloading.percent}%</span>
              <button
                onClick={onCancelDownload}
                className="text-[11px] text-neutral-400 hover:text-critical transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
          <div className="mt-2">
            <div className="w-full bg-white/[0.06] rounded-full h-1.5">
              <div
                className="bg-white h-1.5 rounded-full transition-all duration-300"
                style={{ width: `${downloading.percent}%` }}
              />
            </div>
            <p className="text-[10px] text-neutral-400 mt-1">{downloading.message}</p>
          </div>
        </div>
      )}
      {models.map(model => {
        const isDownloading = downloading?.tag === model.tag;
        const avgDuration = model.totalRequests > 0
          ? formatDuration(Math.round(model.totalDurationMs / model.totalRequests))
          : null;

        return (
          <div
            key={model.tag}
            className={`px-4 py-3 ${model.isActive ? 'border-l-2 border-l-white bg-white/5' : ''}`}
          >
            <div className="flex items-start justify-between gap-3">
              {/* Left: name + badges */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-medium truncate">{model.label}</span>
                  {model.family && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-white/[0.06] rounded text-neutral-400 font-mono">
                      {model.family}
                    </span>
                  )}
                  {model.isActive && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-white/10 text-white rounded font-medium">
                      Active
                    </span>
                  )}
                  {model.isOrchestrator && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-purple-500/20 text-purple-400 rounded font-medium">
                      Orchestrator
                    </span>
                  )}
                  {model.status === 'loaded' && (
                    <span className="text-[10px] px-1.5 py-0.5 bg-success/20 text-success rounded">
                      Loaded
                    </span>
                  )}
                </div>
                <div className="flex items-center gap-1.5 mt-1 flex-wrap">
                  {model.vision && <FeatureBadge label="Vision" color="bg-purple-500/20 text-purple-400" />}
                  {model.toolCalling && <FeatureBadge label="Tools" color="bg-white/10 text-neutral-300" />}
                  {model.sizeGB && (
                    <span className="text-[10px] text-neutral-400">{model.sizeGB} GB</span>
                  )}
                  {model.tag !== model.label && (
                    <span className="text-[10px] text-neutral-600 font-mono">{model.tag}</span>
                  )}
                </div>
              </div>

              {/* Center: stats */}
              <div className="hidden sm:flex items-center gap-4 text-[11px] text-neutral-400 shrink-0">
                {model.totalRequests > 0 && (
                  <span>{model.totalRequests.toLocaleString()} {model.totalRequests === 1 ? 'request' : 'requests'}</span>
                )}
                {avgDuration && <span>avg {avgDuration}</span>}
              </div>

              {/* Right: actions */}
              <div className="flex items-center gap-1.5 shrink-0">
                {isDownloading ? (
                  <div className="flex items-center gap-2">
                    <CircleNotch size={14} className="animate-spin text-white" />
                    <span className="text-xs text-neutral-400">{downloading.percent}%</span>
                    <button
                      onClick={onCancelDownload}
                      className="text-[11px] text-neutral-400 hover:text-critical transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    {!model.isActive && (
                      <button
                        onClick={() => onSetActive(model.tag)}
                        className="px-2 py-1 text-[11px] text-neutral-400 hover:text-white hover:bg-white/10 rounded transition-colors"
                        title="Set as active model"
                      >
                        <Star size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => onSetOrchestrator(model.isOrchestrator ? '' : model.tag)}
                      className={`px-2 py-1 text-[11px] rounded transition-colors ${
                        model.isOrchestrator
                          ? 'text-purple-400 hover:text-neutral-400 hover:bg-white/[0.06]'
                          : 'text-neutral-400 hover:text-purple-400 hover:bg-purple-500/10'
                      }`}
                      title={model.isOrchestrator ? 'Reset orchestrator to auto' : 'Set as orchestrator model'}
                    >
                      <Brain size={14} />
                    </button>
                    {model.status === 'loaded' && !model.isActive && !model.isOrchestrator && (
                      <button
                        onClick={() => onUnload(model.tag)}
                        className="px-2 py-1 text-[11px] text-neutral-400 hover:text-warning hover:bg-warning/10 rounded transition-colors"
                        title="Unload from memory"
                      >
                        <Eject size={14} />
                      </button>
                    )}
                    <button
                      onClick={() => onDelete(model.tag)}
                      className="px-2 py-1 text-[11px] text-neutral-400 hover:text-critical hover:bg-critical/10 rounded transition-colors"
                      title="Delete model"
                    >
                      <Trash size={14} />
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Download progress bar (for reinstall/update) */}
            {isDownloading && (
              <div className="mt-2">
                <div className="w-full bg-white/[0.06] rounded-full h-1.5">
                  <div
                    className="bg-white h-1.5 rounded-full transition-all duration-300"
                    style={{ width: `${downloading.percent}%` }}
                  />
                </div>
                <p className="text-[10px] text-neutral-400 mt-1">{downloading.message}</p>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
