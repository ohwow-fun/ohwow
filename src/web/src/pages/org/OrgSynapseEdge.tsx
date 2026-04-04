import { memo, useState } from 'react';
import type { FlowEdgeProps } from '../automations/flow-builder/renderer/types';
import type { OrgSynapseData } from './org-converter';

const SYNAPSE_COLORS: Record<string, string> = {
  coordination: '#3b82f6',
  delegation: '#f97316',
  nurture: '#22c55e',
  symbiotic: '#8b5cf6',
  immune: '#ef4444',
};

export const OrgSynapseEdge = memo(function OrgSynapseEdge({
  path,
  data,
  sourceX,
  sourceY,
  targetX,
  targetY,
}: FlowEdgeProps) {
  const [hovered, setHovered] = useState(false);

  // Membership edges get a subdued style
  const isMembership = (data as Record<string, unknown> | undefined)?.edgeType === 'membership';
  if (isMembership) {
    return (
      <g>
        <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
        <path
          d={path}
          fill="none"
          stroke="#525252"
          strokeWidth={1}
          strokeDasharray="4 3"
          opacity={0.5}
        />
      </g>
    );
  }

  const d = data as OrgSynapseData | undefined;
  const color = SYNAPSE_COLORS[d?.synapseType || ''] || '#666';
  const width = 1 + (d?.strength || 0.5) * 3;
  const isDashed = d?.origin === 'emergent';

  // Compute label midpoint from endpoints
  const midX =
    sourceX != null && targetX != null
      ? (sourceX + targetX) / 2
      : 0;
  const midY =
    sourceY != null && targetY != null
      ? (sourceY + targetY) / 2
      : 0;

  return (
    <g
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ pointerEvents: 'all' }}
    >
      {/* Invisible wide hit target */}
      <path d={path} fill="none" stroke="transparent" strokeWidth={12} />
      {/* Visible edge */}
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth={width}
        strokeDasharray={isDashed ? '6 4' : undefined}
        opacity={hovered ? 1 : 0.7}
      />
      {/* Type label on hover */}
      {hovered && d?.synapseType && (
        <g transform={`translate(${midX}, ${midY})`}>
          <rect
            x={-40}
            y={-10}
            width={80}
            height={20}
            rx={4}
            fill="#18181b"
            stroke={color}
            strokeWidth={0.5}
            opacity={0.95}
          />
          <text
            x={0}
            y={4}
            textAnchor="middle"
            fill={color}
            fontSize={10}
            fontFamily="system-ui, sans-serif"
          >
            {d.synapseType} {Math.round((d.strength || 0) * 100)}%
          </text>
        </g>
      )}
    </g>
  );
});
