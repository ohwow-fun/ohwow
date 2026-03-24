import { memo } from 'react';
import type { FlowNodeProps } from '../renderer/types';
import { GitBranch } from '@phosphor-icons/react';
import type { ConditionalNodeData } from '../utils/flow-converters';
import { Handle } from './Handle';

const OPERATOR_LABELS: Record<string, string> = {
  equals: '=',
  not_equals: '!=',
  contains: 'contains',
  not_contains: '!contains',
  greater_than: '>',
  less_than: '<',
  exists: 'exists',
  not_exists: '!exists',
};

export const ConditionalNode = memo(function ConditionalNode({ id, data, selected, handleProps }: FlowNodeProps<ConditionalNodeData>) {
  const condData = data;
  const { condition } = condData;
  const operatorLabel = OPERATOR_LABELS[condition.operator] || condition.operator;

  const conditionSummary = condition.field
    ? `${condition.field} ${operatorLabel}${condition.value ? ` ${condition.value}` : ''}`
    : 'No condition set';

  return (
    <div
      className={`
        relative w-[280px] rounded-xl border bg-[#0a0a0a] px-4 py-3
        transition-all duration-150
        ${selected
          ? 'border-orange-500/50 ring-2 ring-orange-500/10 shadow-lg shadow-orange-500/5'
          : 'border-orange-500/20 hover:border-orange-500/40'
        }
      `}
    >
      <Handle nodeId={id} handleId="target" type="target" position="top" handleProps={handleProps} />

      <div className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-orange-500/10">
          <GitBranch size={18} weight="duotone" className="text-orange-400" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-medium uppercase tracking-wider text-orange-400">
            Conditional
          </div>
          <div className="truncate text-sm text-white/70 font-mono text-xs">
            {conditionSummary}
          </div>
        </div>
      </div>

      {/* Then handle (35% bottom) */}
      <Handle nodeId={id} handleId="then" type="source" position="bottom" left="35%" colorClass="bg-emerald-400" handleProps={handleProps} />
      <div
        className="pointer-events-none absolute text-[9px] font-medium text-emerald-400"
        style={{ bottom: -16, left: '35%', transform: 'translateX(-50%)' }}
      >
        Then
      </div>

      {/* Else handle (65% bottom) */}
      <Handle nodeId={id} handleId="else" type="source" position="bottom" left="65%" colorClass="bg-amber-400" handleProps={handleProps} />
      <div
        className="pointer-events-none absolute text-[9px] font-medium text-amber-400"
        style={{ bottom: -16, left: '65%', transform: 'translateX(-50%)' }}
      >
        Else
      </div>
    </div>
  );
});
