import { memo } from 'react';
import type { FlowNodeProps } from '../automations/flow-builder/renderer/types';
import { Handle } from '../automations/flow-builder/nodes/Handle';
import type { OrgAgentData } from './org-converter';

const AUTONOMY_COLORS = ['', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6'];

export const OrgAgentNode = memo(function OrgAgentNode({
  id,
  data,
  selected,
  handleProps,
}: FlowNodeProps) {
  const d = data as OrgAgentData;

  return (
    <div
      className={`rounded-lg border px-3 py-2 bg-zinc-900 w-[220px] ${
        selected
          ? 'border-blue-500 ring-1 ring-blue-500/30'
          : 'border-zinc-700'
      }`}
    >
      <Handle
        nodeId={id}
        handleId="target"
        type="target"
        position="top"
        handleProps={handleProps}
      />
      <div className="flex items-center gap-2">
        <div
          className="w-2 h-2 rounded-full shrink-0"
          style={{
            backgroundColor:
              AUTONOMY_COLORS[d.autonomyLevel] || '#666',
          }}
        />
        <span className="text-sm font-medium text-zinc-200 truncate">
          {d.name}
        </span>
      </div>
      {d.role && (
        <p className="text-xs text-zinc-500 mt-0.5 truncate">{d.role}</p>
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
