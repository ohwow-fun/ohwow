import { memo } from 'react';
import type { FlowNodeProps } from '../renderer/types';
import { Plus } from '@phosphor-icons/react';
import { Handle } from './Handle';

export const AddStepNode = memo(function AddStepNode({ id, data: _data, handleProps }: FlowNodeProps) {
  return (
    <div className="group relative flex h-10 w-[200px] items-center justify-center">
      <Handle nodeId={id} handleId="target" type="target" position="top" handleProps={handleProps} />
      <button
        className="flex h-8 w-8 items-center justify-center rounded-full border border-dashed border-white/10 bg-white/[0.02] text-neutral-600 transition-all hover:border-white/20 hover:bg-white/[0.05] hover:text-white"
        data-testid="add-step-button"
      >
        <Plus size={14} weight="bold" />
      </button>
    </div>
  );
});
