import type { FlowNode } from '../renderer/types';
import type { AutomationStepType } from '../../types';
import { STEP_TYPE_LABELS, STEP_TYPE_DESCRIPTIONS } from '../../types';
import type { AutomationAction } from '../../types';
import type { StepNodeData, ConditionalNodeData } from '../utils/flow-converters';
import { TRIGGER_NODE_ID } from '../utils/flow-converters';
import { AgentPromptConfig } from '../configs/AgentPromptConfig';
import { TransformDataConfig } from '../configs/TransformDataConfig';
import { ContactConfigs } from '../configs/ContactConfigs';
import { WebhookForwardConfig } from '../configs/WebhookForwardConfig';
import { getStepOutputFields } from '../utils/field-utils';
import { ConditionForm } from './ConditionForm';

const STEP_TYPES = Object.entries(STEP_TYPE_LABELS) as [AutomationStepType, string][];

interface StepPanelProps {
  data: StepNodeData | ConditionalNodeData;
  node: FlowNode;
  onChange: (update: Partial<StepNodeData>) => void;
  nodes: FlowNode[];
  automationId?: string;
}

export function StepPanel({ data, node, onChange, nodes }: StepPanelProps) {
  const previousSteps = buildPreviousSteps(node, nodes);
  const sampleFields = getTriggerSampleFields(nodes);
  const samplePayload = getTriggerSamplePayload(nodes);

  const handleStepTypeChange = (newType: AutomationStepType) => {
    const action: AutomationAction = {
      id: data.stepId,
      action_type: newType,
      action_config: {},
    };
    onChange({
      stepType: newType,
      label: STEP_TYPE_LABELS[newType] || newType,
      actionConfig: {},
      outputFields: getStepOutputFields(action),
    });
  };

  const handleConfigChange = (config: Record<string, unknown>) => {
    const action: AutomationAction = {
      id: data.stepId,
      action_type: data.stepType,
      action_config: config,
    };
    onChange({
      actionConfig: config,
      outputFields: getStepOutputFields(action),
    });
  };

  const handleLabelChange = (label: string) => {
    onChange({ label });
  };

  return (
    <div className="space-y-5">
      {/* Label */}
      <div>
        <label className="mb-1 block text-xs text-neutral-400">Label</label>
        <input
          type="text"
          value={data.label}
          onChange={(e) => handleLabelChange(e.target.value)}
          placeholder="Step label"
          className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white placeholder-gray-600 focus:border-white/20 focus:outline-none"
        />
      </div>

      {/* Step Type Selector */}
      <div>
        <label className="mb-1 block text-xs text-neutral-400">Step Type</label>
        <select
          value={data.stepType}
          onChange={(e) => handleStepTypeChange(e.target.value as AutomationStepType)}
          data-testid="flow-step-type"
          className="w-full rounded-md border border-white/10 bg-white/[0.03] px-3 py-2 text-sm text-white focus:border-white/20 focus:outline-none"
        >
          {STEP_TYPES.map(([type, label]) => (
            <option key={type} value={type} className="bg-black">
              {label}
            </option>
          ))}
        </select>
        <p className="mt-1 text-[10px] text-neutral-600">
          {STEP_TYPE_DESCRIPTIONS[data.stepType] || ''}
        </p>
      </div>

      {/* Step-specific config */}
      <div className="border-t border-white/[0.06] pt-4">
        {(data.stepType === 'agent_prompt' || data.stepType === 'run_agent') && (
          <AgentPromptConfig
            config={data.actionConfig}
            onChange={handleConfigChange}
            previousSteps={previousSteps}
            sampleFields={sampleFields}
            samplePayload={samplePayload}
          />
        )}
        {data.stepType === 'transform_data' && (
          <TransformDataConfig
            config={data.actionConfig}
            onChange={handleConfigChange}
            previousSteps={previousSteps}
            sampleFields={sampleFields}
            samplePayload={samplePayload}
          />
        )}
        {data.stepType === 'conditional' && (
          <ConditionForm
            config={data.actionConfig}
            onChange={handleConfigChange}
            previousSteps={previousSteps}
            sampleFields={sampleFields}
            samplePayload={samplePayload}
          />
        )}
        {(data.stepType === 'save_contact' || data.stepType === 'update_contact' || data.stepType === 'log_contact_event') && (
          <ContactConfigs
            stepType={data.stepType}
            config={data.actionConfig}
            onChange={handleConfigChange}
            previousSteps={previousSteps}
            sampleFields={sampleFields}
          />
        )}
        {data.stepType === 'webhook_forward' && (
          <WebhookForwardConfig
            config={data.actionConfig}
            onChange={handleConfigChange}
            previousSteps={previousSteps}
            sampleFields={sampleFields}
          />
        )}
      </div>
    </div>
  );
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function buildPreviousSteps(currentNode: FlowNode, allNodes: FlowNode[]): AutomationAction[] {
  const stepNodes = allNodes.filter(
    (n) => (n.type === 'step' || n.type === 'conditional') && n.id !== currentNode.id,
  );
  const currentData = currentNode.data as StepNodeData;
  return stepNodes
    .filter((n) => {
      const d = n.data as StepNodeData;
      return d.stepIndex >= 0 && d.stepIndex < currentData.stepIndex;
    })
    .sort((a, b) => {
      const aData = a.data as StepNodeData;
      const bData = b.data as StepNodeData;
      return aData.stepIndex - bData.stepIndex;
    })
    .map((n) => {
      const d = n.data as StepNodeData;
      return {
        id: d.stepId,
        action_type: d.stepType,
        action_config: d.actionConfig,
        label: d.label,
      };
    });
}

function getTriggerSampleFields(nodes: FlowNode[]): string[] {
  const triggerNode = nodes.find((n) => n.id === TRIGGER_NODE_ID);
  if (!triggerNode) return [];
  const data = triggerNode.data as { sampleFields?: string[] };
  return data.sampleFields || [];
}

function getTriggerSamplePayload(nodes: FlowNode[]): Record<string, unknown> | null {
  const triggerNode = nodes.find((n) => n.id === TRIGGER_NODE_ID);
  if (!triggerNode) return null;
  const data = triggerNode.data as { samplePayload?: Record<string, unknown> | null };
  return data.samplePayload || null;
}
