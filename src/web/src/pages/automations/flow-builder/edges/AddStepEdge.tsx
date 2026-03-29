import { memo } from 'react';
import type { FlowEdgeProps } from '../renderer/types';

export const AddStepEdge = memo(function AddStepEdge(props: FlowEdgeProps) {
  const { path } = props;

  return (
    <path
      d={path}
      fill="none"
      stroke="rgba(255, 255, 255, 0.15)"
      strokeWidth={1.5}
      strokeDasharray="6 4"
    />
  );
});
