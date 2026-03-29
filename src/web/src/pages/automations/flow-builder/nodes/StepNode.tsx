import { memo } from 'react';
import type { FlowNodeProps } from '../renderer/types';
import {
  Robot,
  PlugsConnected,
  UserPlus,
  UserGear,
  Note,
  Shuffle,
  Kanban,
  WebhooksLogo,
  Camera,
  ChartBar,
  ArrowBendDownRight,
  CheckCircle,
  XCircle,
  Spinner,
} from '@phosphor-icons/react';
import type { StepNodeData } from '../utils/flow-converters';
import { STEP_TYPE_COLORS } from './node-styles';
import { STEP_TYPE_LABELS } from '../../types';
import { useRunOverlay } from '../context/RunOverlayContext';
import { Handle } from './Handle';

const STEP_ICONS: Record<string, typeof Robot> = {
  agent_prompt: Robot,
  run_agent: Robot,
  a2a_call: PlugsConnected,
  save_contact: UserPlus,
  update_contact: UserGear,
  log_contact_event: Note,
  webhook_forward: WebhooksLogo,
  transform_data: Shuffle,
  create_task: Kanban,
  take_screenshot: Camera,
  generate_chart: ChartBar,
};

export const StepNode = memo(function StepNode({ id, data, selected, handleProps }: FlowNodeProps<StepNodeData>) {
  const stepData = data;
  const Icon = STEP_ICONS[stepData.stepType] || Robot;
  const color = STEP_TYPE_COLORS[stepData.stepType] || '#818cf8';
  const typeLabel = STEP_TYPE_LABELS[stepData.stepType] || stepData.stepType;

  const { overlayRun, getStepResult } = useRunOverlay();
  const stepResult = overlayRun ? getStepResult(stepData.stepId) : undefined;

  return (
    <div
      className={`
        relative w-[280px] rounded-xl border bg-[#0a0a0a] px-4 py-3
        transition-all duration-150
        ${selected
          ? 'border-white/30 ring-2 ring-white/10 shadow-lg shadow-white/5'
          : 'border-white/[0.08] hover:border-white/20'
        }
      `}
    >
      <Handle nodeId={id} handleId="target" type="target" position="top" handleProps={handleProps} />

      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${color}15` }}
        >
          <Icon size={18} weight="duotone" style={{ color }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
            {typeLabel}
          </div>
          <div className="truncate text-sm text-white">
            {stepData.label || typeLabel}
          </div>
        </div>
        {stepData.outputFields.length > 0 && (
          <div className="flex shrink-0 items-center gap-1">
            {stepData.outputFields.slice(0, 2).map((field) => (
              <span
                key={field}
                className="rounded bg-white/[0.06] px-1.5 py-0.5 font-mono text-[9px] text-neutral-500"
              >
                {field}
              </span>
            ))}
            {stepData.outputFields.length > 2 && (
              <span className="text-[9px] text-neutral-600">
                +{stepData.outputFields.length - 2}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Input sources line */}
      {stepData.inputSources && stepData.inputSources.length > 0 && (
        <div className="mt-1.5 flex items-center gap-1 text-[9px] text-neutral-600">
          <ArrowBendDownRight size={10} className="shrink-0 text-neutral-600" />
          <span className="truncate">
            from{' '}
            {stepData.inputSources
              .map((s) => `${s.label}(${s.count})`)
              .join(', ')}
          </span>
        </div>
      )}

      {/* Run overlay result */}
      {stepResult && (
        <div className="mt-2 border-t border-white/[0.06] pt-2">
          <div className="flex items-center gap-1.5">
            {stepResult.status === 'completed' && (
              <CheckCircle size={12} className="text-emerald-400" weight="fill" />
            )}
            {stepResult.status === 'failed' && (
              <XCircle size={12} className="text-red-400" weight="fill" />
            )}
            {stepResult.status === 'running' && (
              <Spinner size={12} className="animate-spin text-blue-400" weight="bold" />
            )}
            <span className={`text-[10px] ${
              stepResult.status === 'completed' ? 'text-emerald-400' :
              stepResult.status === 'failed' ? 'text-red-400' :
              'text-blue-400'
            }`}>
              {stepResult.status}
            </span>
          </div>
          {stepResult.status === 'completed' && stepResult.text_output && (
            <p className="mt-1 truncate text-[9px] text-neutral-500">
              {stepResult.text_output.slice(0, 60)}
              {stepResult.text_output.length > 60 ? '...' : ''}
            </p>
          )}
          {stepResult.status === 'completed' && stepResult.output && !stepResult.text_output && (
            <div className="mt-1 flex flex-wrap gap-1">
              {Object.entries(stepResult.output).slice(0, 2).map(([key, val]) => (
                <span key={key} className="font-mono text-[9px] text-neutral-500">
                  {key}={String(val).slice(0, 20)}
                </span>
              ))}
            </div>
          )}
          {stepResult.status === 'failed' && stepResult.error && (
            <p className="mt-1 truncate text-[9px] text-red-400/80">
              {stepResult.error.slice(0, 60)}
            </p>
          )}
        </div>
      )}

      <Handle nodeId={id} handleId="source" type="source" position="bottom" handleProps={handleProps} />
    </div>
  );
});
