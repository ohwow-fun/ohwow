import { useState, useCallback, useMemo, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Automation, AutomationRun, AutomationStepResult, CreateAutomationInput } from '../types';
import { toast } from '../../../components/Toast';
import { api } from '../../../api/client';
import type { TriggerNodeData } from './utils/flow-converters';
import { automationToFlow, emptyAutomationFlow, flowToAutomation, TRIGGER_NODE_ID } from './utils/flow-converters';
import { useFlowState } from './hooks/useFlowState';
import { FlowCanvas } from './FlowCanvas';
import { TopBar } from './TopBar';
import { SidePanel } from './SidePanel';
import { RunOverlayBar } from './RunOverlayBar';
import { RunOverlayProvider } from './context/RunOverlayContext';

interface FlowBuilderProps {
  automation?: Automation | null;
}

const EMPTY_RUNS: AutomationRun[] = [];

export function FlowBuilder({ automation }: FlowBuilderProps) {
  const navigate = useNavigate();
  const isNew = !automation;

  // Run state
  const [runs, setRuns] = useState<AutomationRun[]>(EMPTY_RUNS);
  const [overlayEnabled, setOverlayEnabled] = useState(false);
  const [selectedOverlayRun, setSelectedOverlayRun] = useState<AutomationRun | null>(null);

  const overlayRun = useMemo(
    () => overlayEnabled ? (selectedOverlayRun || runs[0] || null) : null,
    [overlayEnabled, selectedOverlayRun, runs],
  );

  const getStepResult = useCallback(
    (stepId: string): AutomationStepResult | undefined => {
      if (!overlayRun) return undefined;
      return overlayRun.step_results?.find((r) => r.step_id === stepId);
    },
    [overlayRun],
  );

  const runOverlayValue = useMemo(
    () => ({ overlayRun, getStepResult }),
    [overlayRun, getStepResult],
  );

  // Load run history on mount for existing automations
  useEffect(() => {
    if (automation?.id) {
      api<{ data: { runs: AutomationRun[] } }>(`/api/automations/${automation.id}/runs`)
        .then((res) => setRuns(res.data?.runs || []))
        .catch(() => {});
    }
  }, [automation?.id]);

  // Initialize flow from automation or empty
  const { nodes: initialNodes, edges: initialEdges, hasCustomPositions } = useMemo(
    () => (automation ? automationToFlow(automation) : emptyAutomationFlow()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [automation?.id],
  );

  const {
    nodes,
    edges,
    selectedNode,
    selectedNodeId,
    onNodeClick,
    onPaneClick,
    updateNodeData,
    updateNodePosition,
    deleteStep,
    connectNodes,
    insertStepBetween,
    setSelectedNodeId,
  } = useFlowState(initialNodes, initialEdges, { hasCustomPositions });

  const [saving, setSaving] = useState(false);

  // Get name/description from trigger node data
  const triggerNode = nodes.find((n) => n.id === TRIGGER_NODE_ID);
  const triggerData = triggerNode?.data as TriggerNodeData | undefined;
  const name = triggerData?.name || '';
  const description = triggerData?.description || '';

  const handleNameChange = useCallback(
    (newName: string) => {
      updateNodeData(TRIGGER_NODE_ID, { name: newName });
    },
    [updateNodeData],
  );

  const handleDescriptionChange = useCallback(
    (newDesc: string) => {
      updateNodeData(TRIGGER_NODE_ID, { description: newDesc });
    },
    [updateNodeData],
  );

  const handleSave = useCallback(async () => {
    if (!name.trim()) {
      toast('error', 'Give it a name first');
      return;
    }

    setSaving(true);
    try {
      const payload = flowToAutomation(nodes, edges);

      const currentTriggerData = (nodes.find((n) => n.id === TRIGGER_NODE_ID)?.data ?? {}) as Partial<TriggerNodeData>;

      const savePayload: CreateAutomationInput & { cooldown_seconds: number } = {
        name: payload.name,
        description: payload.description,
        trigger_type: payload.trigger_type,
        trigger_config: payload.trigger_config,
        steps: payload.steps,
        variables: payload.variables,
        cooldown_seconds: payload.cooldown_seconds,
        node_positions: payload.node_positions,
        sample_payload: currentTriggerData.samplePayload ?? null,
        sample_fields: currentTriggerData.sampleFields?.length ? currentTriggerData.sampleFields : null,
      };

      if (isNew) {
        const res = await api<{ data: { id: string } }>('/api/automations', {
          method: 'POST',
          body: JSON.stringify(savePayload),
        });
        toast('success', 'Automation created');
        navigate(`/automations/${res.data.id}/edit`);
      } else {
        await api(`/api/automations/${automation!.id}`, {
          method: 'PATCH',
          body: JSON.stringify(savePayload),
        });
        toast('success', 'Automation updated');
      }
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setSaving(false);
    }
  }, [name, nodes, edges, isNew, automation, navigate]);

  const handleRun = useCallback(async () => {
    if (!automation?.id) return;
    try {
      await api(`/api/automations/${automation.id}/execute`, { method: 'POST' });
      toast('success', 'Automation started');
    } catch (err) {
      toast('error', err instanceof Error ? err.message : 'Couldn\'t run automation. Try again?');
    }
  }, [automation?.id]);

  const handleNodeDrag = useCallback(
    (nodeId: string, position: { x: number; y: number }) => {
      updateNodePosition(nodeId, position);
    },
    [updateNodePosition],
  );

  const handleClosePanel = useCallback(() => {
    setSelectedNodeId(null);
  }, [setSelectedNodeId]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (e.key === 'Escape') {
        setSelectedNodeId(null);
      }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedNode && selectedNode.type !== 'trigger') {
        deleteStep(selectedNode.id);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedNode, deleteStep, handleSave, setSelectedNodeId]);

  return (
    <div className="flex h-full flex-col" data-testid="flow-builder">
      <TopBar
        name={name}
        onNameChange={handleNameChange}
        description={description}
        onDescriptionChange={handleDescriptionChange}
        onSave={handleSave}
        onRun={automation?.trigger_type === 'manual' ? handleRun : undefined}
        saving={saving}
        isNew={isNew}
      />

      <RunOverlayProvider value={runOverlayValue}>
        <div className="flex min-h-0 flex-1">
          <div className="relative min-w-0 flex-1">
            <FlowCanvas
              nodes={nodes}
              edges={edges}
              selectedNodeId={selectedNodeId}
              onNodeClick={onNodeClick}
              onPaneClick={onPaneClick}
              onConnect={connectNodes}
              onNodeDrag={handleNodeDrag}
              onInsertStep={insertStepBetween}
            />
            {!isNew && (
              <RunOverlayBar
                runs={runs}
                selectedRun={selectedOverlayRun}
                onSelectRun={setSelectedOverlayRun}
                overlayEnabled={overlayEnabled}
                onToggleOverlay={setOverlayEnabled}
              />
            )}
          </div>

          <SidePanel
            selectedNode={selectedNode}
            onClose={handleClosePanel}
            onUpdateNodeData={updateNodeData}
            onDeleteStep={deleteStep}
            nodes={nodes}
            automationId={automation?.id}
          />
        </div>
      </RunOverlayProvider>
    </div>
  );
}
