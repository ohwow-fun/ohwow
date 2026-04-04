import { memo } from 'react';
import type { FlowNodeProps } from '../automations/flow-builder/renderer/types';
import { Handle } from '../automations/flow-builder/nodes/Handle';
import type { OrgSystemData } from './org-converter';

const SYSTEM_COLORS: Record<string, string> = {
  organ_system: '#3b82f6',
  tissue: '#8b5cf6',
  microbiome: '#10b981',
};

export const OrgSystemNode = memo(function OrgSystemNode({
  id,
  data,
  selected,
  handleProps,
}: FlowNodeProps) {
  const d = data as OrgSystemData;
  const color = SYSTEM_COLORS[d.systemType] || '#3b82f6';

  return (
    <div
      className={`rounded-lg border-2 px-3 py-2 bg-zinc-950 w-[240px] ${
        selected ? 'ring-1 ring-blue-500/30' : ''
      }`}
      style={{ borderColor: color }}
    >
      <Handle
        nodeId={id}
        handleId="target"
        type="target"
        position="top"
        handleProps={handleProps}
      />
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-zinc-200 truncate">
          {d.name}
        </span>
        <span className="text-[10px] bg-zinc-800 text-zinc-400 rounded px-1.5 py-0.5 shrink-0 ml-2">
          {d.agentCount} {d.agentCount === 1 ? 'agent' : 'agents'}
        </span>
      </div>
      {d.telos && (
        <p className="text-xs text-zinc-500 mt-0.5 truncate">{d.telos}</p>
      )}
      <Handle
        nodeId={id}
        handleId="source"
        type="source"
        position="bottom"
        handleProps={handleProps}
      />
    </div>
  );
});
