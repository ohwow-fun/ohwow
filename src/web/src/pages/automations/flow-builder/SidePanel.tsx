import { X, Trash } from '@phosphor-icons/react';
import { motion, AnimatePresence } from 'framer-motion';
import type { FlowNode } from './renderer/types';
import type { TriggerNodeData, StepNodeData } from './utils/flow-converters';
import { TriggerPanel } from './panels/TriggerPanel';
import { StepPanel } from './panels/StepPanel';

interface SidePanelProps {
  selectedNode: FlowNode | null;
  onClose: () => void;
  onUpdateNodeData: (nodeId: string, data: Partial<TriggerNodeData | StepNodeData>) => void;
  onDeleteStep: (nodeId: string) => void;
  nodes: FlowNode[];
  automationId?: string;
}

export function SidePanel({
  selectedNode,
  onClose,
  onUpdateNodeData,
  onDeleteStep,
  nodes,
  automationId,
}: SidePanelProps) {
  const isTrigger = selectedNode?.type === 'trigger';
  const isStep = selectedNode?.type === 'step' || selectedNode?.type === 'conditional';

  return (
    <AnimatePresence>
      {selectedNode && (
        <motion.div
          initial={{ width: 0, opacity: 0 }}
          animate={{ width: 400, opacity: 1 }}
          exit={{ width: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="flex h-full shrink-0 flex-col overflow-hidden border-l border-white/[0.06]"
          data-testid="flow-side-panel"
        >
          <div className="flex h-full w-[400px] flex-col">
            {/* Header */}
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
              <h3 className="text-sm font-medium text-white">
                {isTrigger ? 'Trigger' : 'Step Configuration'}
              </h3>
              <div className="flex items-center gap-1">
                {isStep && !isTrigger && (
                  <button
                    onClick={() => onDeleteStep(selectedNode.id)}
                    className="flex h-7 w-7 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-red-500/10 hover:text-red-400"
                    data-testid="flow-delete-step"
                  >
                    <Trash size={14} />
                  </button>
                )}
                <button
                  onClick={onClose}
                  className="flex h-7 w-7 items-center justify-center rounded text-neutral-500 transition-colors hover:bg-white/[0.05] hover:text-white"
                >
                  <X size={14} />
                </button>
              </div>
            </div>

            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4 pb-6">
              {isTrigger && (
                <TriggerPanel
                  data={selectedNode.data as TriggerNodeData}
                  onChange={(update) => onUpdateNodeData(selectedNode.id, update)}
                />
              )}
              {isStep && !isTrigger && (
                <StepPanel
                  data={selectedNode.data as StepNodeData}
                  node={selectedNode}
                  onChange={(update) => onUpdateNodeData(selectedNode.id, update)}
                  nodes={nodes}
                  automationId={automationId}
                />
              )}
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
