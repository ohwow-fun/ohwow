/**
 * Converts between Automation data model and ReactFlow nodes/edges.
 *
 * The canonical data model stays as AutomationStep[]. The canvas nodes/edges
 * are a derived view computed on load and serialized back on save.
 */

import type { FlowNode, FlowEdge } from '../renderer/types';
import type {
  Automation,
  AutomationStep,
  AutomationTriggerType,
  AutomationVariable,
} from '../../types';
import type { AutomationAction } from '../../types';
import type { CreateAutomationInput } from '../../types';
import { STEP_TYPE_LABELS } from '../../types';
import { getStepOutputFields, extractTemplateVars } from './field-utils';

// --- Node data types --------------------------------------------------------

export interface TriggerNodeData {
  triggerType: AutomationTriggerType;
  triggerConfig: Record<string, unknown>;
  name: string;
  description: string;
  cooldownSeconds: number;
  variables: AutomationVariable[];
  sampleFields: string[];
  samplePayload: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface InputSource {
  label: string;
  count: number;
}

export interface StepNodeData {
  stepIndex: number;
  stepId: string;
  stepType: AutomationStep['step_type'];
  label: string;
  actionConfig: Record<string, unknown>;
  outputFields: string[];
  inputSources?: InputSource[];
  // Original step fields for backward compat
  agentId?: string;
  agentName?: string;
  prompt?: string;
  requiredIntegrations?: string[];
  connectionId?: string;
  [key: string]: unknown;
}

export interface AddStepNodeData {
  parentNodeId: string;
  insertIndex: number;
  branchType?: 'then' | 'else';
  [key: string]: unknown;
}

export interface ConditionalNodeData extends StepNodeData {
  condition: { field: string; operator: string; value?: string };
  [key: string]: unknown;
}

// --- Default node dimensions (prevents xyflow measurement cycle) ------------

const NODE_DIMENSIONS: Record<string, { width: number; height: number }> = {
  trigger: { width: 280, height: 80 },
  step: { width: 280, height: 80 },
  conditional: { width: 280, height: 100 },
  addStep: { width: 200, height: 40 },
};

// --- Node IDs ---------------------------------------------------------------

export const TRIGGER_NODE_ID = 'trigger';
export const addStepNodeId = (parentId: string) => `add-after-${parentId}`;

// --- Input source computation -----------------------------------------------

function computeInputSources(
  step: AutomationStep,
  previousSteps: { id: string; label: string }[],
): InputSource[] {
  // Stringify all template-bearing fields
  const searchable = JSON.stringify(step.action_config || {}) + (step.prompt || '');
  const vars = extractTemplateVars(searchable);
  if (vars.length === 0) return [];

  // Group by prefix (trigger, step_1, step_2, etc.)
  const groups: Record<string, number> = {};
  for (const v of vars) {
    const prefix = v.split('.')[0]; // "trigger", "step_1", etc.
    groups[prefix] = (groups[prefix] || 0) + 1;
  }

  // Map prefixes to labels
  const sources: InputSource[] = [];
  for (const [prefix, count] of Object.entries(groups)) {
    if (prefix === 'trigger') {
      sources.push({ label: 'Trigger', count });
    } else {
      // Try to find matching step by prefix like "step_1"
      const match = previousSteps.find((s) => s.id === prefix);
      sources.push({ label: match?.label || prefix, count });
    }
  }

  return sources;
}

// --- Automation -> Flow -----------------------------------------------------

export function automationToFlow(automation: Automation): {
  nodes: FlowNode[];
  edges: FlowEdge[];
  hasCustomPositions: boolean;
} {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const savedPositions = automation.node_positions;

  // Trigger node
  nodes.push({
    id: TRIGGER_NODE_ID,
    type: 'trigger',
    position: savedPositions?.[TRIGGER_NODE_ID] || { x: 0, y: 0 },
    ...NODE_DIMENSIONS.trigger,
    data: {
      triggerType: automation.trigger_type,
      triggerConfig: automation.trigger_config,
      name: automation.name,
      description: automation.description || '',
      cooldownSeconds: automation.cooldown_seconds,
      variables: automation.variables || [],
      sampleFields: automation.sample_fields || [],
      samplePayload: automation.sample_payload || null,
    } satisfies TriggerNodeData,
  });

  let previousNodeId = TRIGGER_NODE_ID;
  const previousSteps: { id: string; label: string }[] = [];

  for (let i = 0; i < automation.steps.length; i++) {
    const step = automation.steps[i];
    const nodeId = step.id;

    if (step.step_type === 'conditional') {
      // Conditional node
      const config = step.action_config || {};
      const condition = (config.condition || { field: '', operator: 'equals', value: '' }) as {
        field: string;
        operator: string;
        value?: string;
      };

      nodes.push({
        id: nodeId,
        type: 'conditional',
        position: savedPositions?.[nodeId] || { x: 0, y: 0 },
        ...NODE_DIMENSIONS.conditional,
        data: {
          stepIndex: i,
          stepId: step.id,
          stepType: step.step_type,
          label: step.label || 'Conditional',
          actionConfig: config,
          outputFields: ['branch', 'branch_output'],
          condition,
        } satisfies ConditionalNodeData,
      });

      edges.push({
        id: `${previousNodeId}->${nodeId}`,
        source: previousNodeId,
        target: nodeId,
        type: 'dataFlow',
      });

      // Then branch nodes
      const thenActions = (config.then_actions || []) as AutomationAction[];
      let thenPrev = nodeId;
      for (let t = 0; t < thenActions.length; t++) {
        const action = thenActions[t];
        const thenNodeId = `${nodeId}-then-${t}`;
        nodes.push({
          id: thenNodeId,
          type: 'step',
          position: savedPositions?.[thenNodeId] || { x: 0, y: 0 },
          ...NODE_DIMENSIONS.step,
          data: {
            stepIndex: -1, // branch steps don't have a main-chain index
            stepId: action.id,
            stepType: action.action_type as AutomationStep['step_type'],
            label: action.label || STEP_TYPE_LABELS[action.action_type as AutomationStep['step_type']] || action.action_type,
            actionConfig: action.action_config || {},
            outputFields: getStepOutputFields(action),
            branchType: 'then',
            parentConditionalId: nodeId,
            branchIndex: t,
          } satisfies StepNodeData & { branchType: string; parentConditionalId: string; branchIndex: number },
        });
        edges.push({
          id: `${thenPrev}->${thenNodeId}`,
          source: thenPrev,
          sourceHandle: thenPrev === nodeId ? 'then' : undefined,
          target: thenNodeId,
          type: 'dataFlow',
          data: { branchType: 'then' },
        });
        thenPrev = thenNodeId;
      }

      // Add "+" node at end of then branch
      const thenAddId = addStepNodeId(`${nodeId}-then`);
      nodes.push({
        id: thenAddId,
        type: 'addStep',
        position: savedPositions?.[thenAddId] || { x: 0, y: 0 },
        ...NODE_DIMENSIONS.addStep,
        data: {
          parentNodeId: thenPrev,
          insertIndex: thenActions.length,
          branchType: 'then',
          conditionalNodeId: nodeId,
        } satisfies AddStepNodeData & { conditionalNodeId: string },
      });
      edges.push({
        id: `${thenPrev}->${thenAddId}`,
        source: thenPrev,
        sourceHandle: thenPrev === nodeId ? 'then' : undefined,
        target: thenAddId,
        type: 'addStepEdge',
        data: { branchType: 'then' },
      });

      // Else branch nodes
      const elseActions = (config.else_actions || []) as AutomationAction[];
      let elsePrev = nodeId;
      for (let e = 0; e < elseActions.length; e++) {
        const action = elseActions[e];
        const elseNodeId = `${nodeId}-else-${e}`;
        nodes.push({
          id: elseNodeId,
          type: 'step',
          position: savedPositions?.[elseNodeId] || { x: 0, y: 0 },
          ...NODE_DIMENSIONS.step,
          data: {
            stepIndex: -1,
            stepId: action.id,
            stepType: action.action_type as AutomationStep['step_type'],
            label: action.label || STEP_TYPE_LABELS[action.action_type as AutomationStep['step_type']] || action.action_type,
            actionConfig: action.action_config || {},
            outputFields: getStepOutputFields(action),
            branchType: 'else',
            parentConditionalId: nodeId,
            branchIndex: e,
          } satisfies StepNodeData & { branchType: string; parentConditionalId: string; branchIndex: number },
        });
        edges.push({
          id: `${elsePrev}->${elseNodeId}`,
          source: elsePrev,
          sourceHandle: elsePrev === nodeId ? 'else' : undefined,
          target: elseNodeId,
          type: 'dataFlow',
          data: { branchType: 'else' },
        });
        elsePrev = elseNodeId;
      }

      // Add "+" node at end of else branch
      const elseAddId = addStepNodeId(`${nodeId}-else`);
      nodes.push({
        id: elseAddId,
        type: 'addStep',
        position: savedPositions?.[elseAddId] || { x: 0, y: 0 },
        ...NODE_DIMENSIONS.addStep,
        data: {
          parentNodeId: elsePrev,
          insertIndex: elseActions.length,
          branchType: 'else',
          conditionalNodeId: nodeId,
        } satisfies AddStepNodeData & { conditionalNodeId: string },
      });
      edges.push({
        id: `${elsePrev}->${elseAddId}`,
        source: elsePrev,
        sourceHandle: elsePrev === nodeId ? 'else' : undefined,
        target: elseAddId,
        type: 'addStepEdge',
        data: { branchType: 'else' },
      });

      previousSteps.push({ id: step.id, label: step.label || 'Conditional' });
      previousNodeId = nodeId;
    } else {
      // Regular step node
      const stepAction: AutomationAction = {
        id: step.id,
        action_type: step.step_type,
        action_config: step.action_config || {},
        label: step.label,
      };

      const stepLabel = step.label || STEP_TYPE_LABELS[step.step_type] || step.step_type;
      const inputSources = computeInputSources(step, previousSteps);

      nodes.push({
        id: nodeId,
        type: 'step',
        position: savedPositions?.[nodeId] || { x: 0, y: 0 },
        ...NODE_DIMENSIONS.step,
        data: {
          stepIndex: i,
          stepId: step.id,
          stepType: step.step_type,
          label: stepLabel,
          actionConfig: step.action_config || {},
          outputFields: getStepOutputFields(stepAction),
          inputSources,
          agentId: step.agent_id,
          agentName: step.agent_name,
          prompt: step.prompt,
          requiredIntegrations: step.required_integrations,
          connectionId: step.connection_id,
        } satisfies StepNodeData,
      });

      edges.push({
        id: `${previousNodeId}->${nodeId}`,
        source: previousNodeId,
        target: nodeId,
        type: 'dataFlow',
      });

      previousSteps.push({ id: step.id, label: stepLabel });
      previousNodeId = nodeId;
    }
  }

  // Add "+" node at the end of main chain
  const finalAddId = addStepNodeId(previousNodeId);
  nodes.push({
    id: finalAddId,
    type: 'addStep',
    position: savedPositions?.[finalAddId] || { x: 0, y: 0 },
    ...NODE_DIMENSIONS.addStep,
    data: {
      parentNodeId: previousNodeId,
      insertIndex: automation.steps.length,
    } satisfies AddStepNodeData,
  });
  edges.push({
    id: `${previousNodeId}->${finalAddId}`,
    source: previousNodeId,
    target: finalAddId,
    type: 'addStepEdge',
  });

  return { nodes, edges, hasCustomPositions: !!savedPositions && Object.keys(savedPositions).length > 0 };
}

// --- Flow -> Automation (for saving) ----------------------------------------

export function flowToAutomation(
  nodes: FlowNode[],
  edges: FlowEdge[],
): CreateAutomationInput & { cooldown_seconds: number; node_positions: Record<string, { x: number; y: number }> } {
  const triggerNode = nodes.find((n) => n.type === 'trigger');
  if (!triggerNode) {
    throw new Error('No trigger node found');
  }

  const triggerData = triggerNode.data as TriggerNodeData;

  // Collect main-chain steps in order by walking edges from trigger
  const steps = collectMainChainSteps(nodes, edges);

  // Collect positions from all real nodes (skip addStep nodes)
  const node_positions: Record<string, { x: number; y: number }> = {};
  for (const node of nodes) {
    if (node.type !== 'addStep') {
      node_positions[node.id] = { x: node.position.x, y: node.position.y };
    }
  }

  return {
    name: triggerData.name,
    description: triggerData.description || undefined,
    trigger_type: triggerData.triggerType,
    trigger_config: triggerData.triggerConfig,
    steps,
    variables: triggerData.variables?.length ? triggerData.variables : undefined,
    cooldown_seconds: triggerData.cooldownSeconds,
    node_positions,
  };
}

function collectMainChainSteps(nodes: FlowNode[], edges: FlowEdge[]): AutomationStep[] {
  const steps: AutomationStep[] = [];

  // Build adjacency: source -> target (excluding branch edges)
  const mainEdges = edges.filter(
    (e) => !e.sourceHandle || (e.sourceHandle !== 'then' && e.sourceHandle !== 'else')
  );

  // Walk from trigger
  let currentId = TRIGGER_NODE_ID;
  const visited = new Set<string>();

  while (true) {
    visited.add(currentId);
    const nextEdge = mainEdges.find((e) => e.source === currentId && !visited.has(e.target));
    if (!nextEdge) break;

    const nextNode = nodes.find((n) => n.id === nextEdge.target);
    if (!nextNode || nextNode.type === 'addStep') break;

    if (nextNode.type === 'conditional') {
      const data = nextNode.data as ConditionalNodeData;
      const thenActions = collectBranchActions(nodes, edges, nextNode.id, 'then');
      const elseActions = collectBranchActions(nodes, edges, nextNode.id, 'else');

      steps.push({
        id: data.stepId,
        step_type: 'conditional',
        label: data.label,
        action_config: {
          ...data.actionConfig,
          condition: data.condition,
          then_actions: thenActions,
          else_actions: elseActions,
        },
      });
    } else if (nextNode.type === 'step') {
      const data = nextNode.data as StepNodeData;
      steps.push(stepNodeDataToAutomationStep(data));
    }

    currentId = nextNode.id;
  }

  // Re-number step IDs
  return steps.map((s, i) => ({ ...s, id: `step_${i + 1}` }));
}

function collectBranchActions(
  nodes: FlowNode[],
  edges: FlowEdge[],
  conditionalId: string,
  branch: 'then' | 'else',
): AutomationAction[] {
  const actions: AutomationAction[] = [];

  // Find the first edge from the conditional with the branch handle
  let currentId = conditionalId;
  const visited = new Set<string>();

  while (true) {
    visited.add(currentId);
    const nextEdge = edges.find(
      (e) =>
        e.source === currentId &&
        !visited.has(e.target) &&
        (currentId === conditionalId ? e.sourceHandle === branch : true)
    );
    if (!nextEdge) break;

    const nextNode = nodes.find((n) => n.id === nextEdge.target);
    if (!nextNode || nextNode.type === 'addStep') break;

    if (nextNode.type === 'step') {
      const data = nextNode.data as StepNodeData;
      actions.push({
        id: data.stepId,
        action_type: data.stepType,
        action_config: data.actionConfig,
        label: data.label,
      });
    }

    currentId = nextNode.id;
  }

  // Re-number
  return actions.map((a, i) => ({ ...a, id: `${branch}_step_${i + 1}` }));
}

function stepNodeDataToAutomationStep(data: StepNodeData): AutomationStep {
  return {
    id: data.stepId,
    step_type: data.stepType,
    label: data.label,
    action_config: data.actionConfig,
    agent_id: data.agentId,
    agent_name: data.agentName,
    prompt: data.prompt,
    required_integrations: data.requiredIntegrations,
    connection_id: data.connectionId,
  };
}

// --- Empty automation for "new" route ---------------------------------------

export function emptyAutomationFlow(): { nodes: FlowNode[]; edges: FlowEdge[]; hasCustomPositions: boolean } {
  const emptyAutomation: Automation = {
    id: '',
    workspace_id: '',
    name: '',
    description: null,
    enabled: false,
    trigger_type: 'webhook',
    trigger_config: {},
    steps: [],
    variables: [],
    cooldown_seconds: 0,
    last_fired_at: null,
    fire_count: 0,
    sample_payload: null,
    sample_fields: null,
    status: 'draft',
    created_at: '',
    updated_at: '',
  };
  return automationToFlow(emptyAutomation);
}
