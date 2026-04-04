/**
 * InferenceStatusBar
 * Shows active inference provider, VRAM usage, and model switch progress.
 */

import { CircleNotch, Lightning, Cpu, CheckCircle, XCircle } from '@phosphor-icons/react';
import type { InferenceCapacity } from '../../../hooks/useInferenceStatus';

interface SwitchState {
  model: string;
  status: 'switching' | 'complete' | 'failed';
  provider?: string;
  reason?: string;
}

interface Props {
  activeProvider: 'mlx' | 'llama-cpp' | 'ollama';
  mlxModel?: string | null;
  switchInProgress: boolean;
  switchState: SwitchState | null;
  capacity: InferenceCapacity | null;
}

const PROVIDER_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  mlx: { label: 'MLX', color: 'text-emerald-400', bg: 'bg-emerald-500/20' },
  'llama-cpp': { label: 'llama.cpp', color: 'text-sky-400', bg: 'bg-sky-500/20' },
  ollama: { label: 'Ollama', color: 'text-neutral-400', bg: 'bg-white/[0.06]' },
};

function VramBar({ capacity }: { capacity: InferenceCapacity }) {
  const usedPercent = capacity.totalVramGB > 0
    ? Math.min(100, Math.round((capacity.usedVramGB / capacity.totalVramGB) * 100))
    : 0;

  const barColor = usedPercent > 80
    ? 'bg-red-500'
    : usedPercent > 60
      ? 'bg-amber-500'
      : 'bg-emerald-500';

  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-neutral-500 whitespace-nowrap">VRAM</span>
      <div className="w-20 bg-white/[0.06] rounded-full h-1.5">
        <div
          className={`${barColor} h-1.5 rounded-full transition-all duration-500`}
          style={{ width: `${usedPercent}%` }}
        />
      </div>
      <span className="text-[10px] text-neutral-500 whitespace-nowrap">
        {capacity.usedVramGB.toFixed(1)}/{capacity.totalVramGB.toFixed(0)} GB
      </span>
    </div>
  );
}

export function InferenceStatusBar({ activeProvider, mlxModel, switchInProgress, switchState, capacity }: Props) {
  const provider = PROVIDER_LABELS[activeProvider] || PROVIDER_LABELS.ollama;

  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-lg px-3 py-2 mb-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {/* Left: provider badge + model */}
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium ${provider.bg} ${provider.color}`}>
            {activeProvider === 'mlx' ? (
              <Lightning size={10} weight="fill" />
            ) : (
              <Cpu size={10} />
            )}
            {provider.label}
          </div>
          {mlxModel && (
            <span className="text-[10px] text-neutral-500 font-mono truncate max-w-[200px]">
              {mlxModel}
            </span>
          )}
        </div>

        {/* Center: switch progress */}
        {(switchInProgress || switchState) && (
          <div className="flex items-center gap-1.5">
            {switchState?.status === 'switching' || switchInProgress ? (
              <>
                <CircleNotch size={12} className="animate-spin text-sky-400" />
                <span className="text-[10px] text-sky-400">
                  Switching to {switchState?.model || 'new model'}...
                </span>
              </>
            ) : switchState?.status === 'complete' ? (
              <>
                <CheckCircle size={12} className="text-emerald-400" />
                <span className="text-[10px] text-emerald-400">
                  Now using {switchState.model} via {switchState.provider}
                </span>
              </>
            ) : switchState?.status === 'failed' ? (
              <>
                <XCircle size={12} className="text-red-400" />
                <span className="text-[10px] text-red-400">
                  Switch failed: {switchState.reason}
                </span>
              </>
            ) : null}
          </div>
        )}

        {/* Right: VRAM bar */}
        {capacity && capacity.totalVramGB > 0 && (
          <VramBar capacity={capacity} />
        )}
      </div>
    </div>
  );
}
