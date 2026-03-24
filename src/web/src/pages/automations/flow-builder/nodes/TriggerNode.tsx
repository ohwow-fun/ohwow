import { memo } from 'react';
import type { FlowNodeProps } from '../renderer/types';
import { Globe, CalendarBlank, BellRinging, Hand } from '@phosphor-icons/react';
import type { TriggerNodeData } from '../utils/flow-converters';
import { TRIGGER_TYPE_COLORS } from './node-styles';
import { Handle } from './Handle';

const TRIGGER_ICONS = {
  webhook: Globe,
  schedule: CalendarBlank,
  event: BellRinging,
  manual: Hand,
} as const;

const TRIGGER_LABELS = {
  webhook: 'Webhook',
  schedule: 'Schedule',
  event: 'Event',
  manual: 'Manual',
} as const;

export const TriggerNode = memo(function TriggerNode({ id, data, selected, handleProps }: FlowNodeProps<TriggerNodeData>) {
  const triggerData = data;
  const Icon = TRIGGER_ICONS[triggerData.triggerType] || Globe;
  const color = TRIGGER_TYPE_COLORS[triggerData.triggerType] || '#60a5fa';
  const label = TRIGGER_LABELS[triggerData.triggerType] || 'Trigger';

  return (
    <div
      className={`
        relative w-[280px] rounded-xl border-2 bg-[#0a0a0a] px-4 py-3
        transition-all duration-150
        ${selected ? 'ring-2 ring-white/20 shadow-lg shadow-white/5' : 'hover:border-white/20'}
      `}
      style={{ borderColor: selected ? color : `${color}40` }}
    >
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 items-center justify-center rounded-lg"
          style={{ backgroundColor: `${color}15` }}
        >
          <Icon size={20} weight="fill" style={{ color }} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-medium uppercase tracking-wider" style={{ color }}>
            {label} Trigger
          </div>
          <div className="truncate text-sm font-medium text-white">
            {triggerData.name || 'Untitled automation'}
          </div>
        </div>
      </div>

      {triggerData.sampleFields && triggerData.sampleFields.length > 0 && (
        <div className="mt-1.5 text-[10px] text-neutral-500">
          Emits {triggerData.sampleFields.length}{' '}
          {triggerData.sampleFields.length === 1 ? 'field' : 'fields'}
        </div>
      )}

      <Handle nodeId={id} handleId="source" type="source" position="bottom" handleProps={handleProps} />
    </div>
  );
});
