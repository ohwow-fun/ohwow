/**
 * Workflows Screen
 * List and run workflows. Accessed from Settings via 'w' key.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { ScrollableList } from '../components/scrollable-list.js';
import { TextPanel } from '../components/text-panel.js';
import { ConfirmDialog } from '../components/confirm-dialog.js';

interface WorkflowsProps {
  db: DatabaseAdapter | null;
  engine: { executeTask: (agentId: string, taskId: string) => Promise<unknown> } | null;
  workspaceId: string;
  onBack: () => void;
  embedded?: boolean;
}

interface Workflow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  steps: unknown[];
  run_count: number;
}

export function Workflows({ db, engine, workspaceId, onBack, embedded }: WorkflowsProps) {
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [selectedWorkflow, setSelectedWorkflow] = useState<Workflow | null>(null);
  const [showRunConfirm, setShowRunConfirm] = useState(false);

  useEffect(() => {
    if (!db) return;

    const fetch = async () => {
      const { data } = await db
        .from('agent_workforce_workflows')
        .select('id, name, description, status, steps, run_count')
        .order('created_at', { ascending: false });

      if (data) {
        setWorkflows((data as Array<Record<string, unknown>>).map(w => ({
          id: w.id as string,
          name: (w.name as string) || 'Unnamed',
          description: w.description as string | null,
          status: (w.status as string) || 'active',
          steps: typeof w.steps === 'string' ? JSON.parse(w.steps as string) : (w.steps as unknown[] || []),
          run_count: (w.run_count as number) || 0,
        })));
      }
    };

    fetch();
  }, [db]);

  const runWorkflow = async () => {
    if (!db || !engine || !selectedWorkflow) return;

    const steps = selectedWorkflow.steps as Array<Record<string, unknown>>;
    for (const step of steps) {
      const stepType = (step.step_type || step.type) as string | undefined;
      const stepAction = (step.action || step.prompt) as string | undefined;
      const agentId = step.agent_id as string | undefined;

      if ((stepType === 'agent_prompt' || stepType === 'agent_task' || !stepType) && agentId && stepAction) {
        const { data: task } = await db
          .from('agent_workforce_tasks')
          .insert({
            workspace_id: workspaceId,
            agent_id: agentId,
            title: stepAction.slice(0, 100),
            input: stepAction,
            status: 'pending',
          })
          .select('id')
          .single();

        if (task) {
          engine.executeTask(agentId, (task as { id: string }).id).catch(() => {});
        }
      }
    }

    // Increment run count
    await db.from('agent_workforce_workflows').update({
      run_count: selectedWorkflow.run_count + 1,
      updated_at: new Date().toISOString(),
    }).eq('id', selectedWorkflow.id);

    setWorkflows(prev => prev.map(w =>
      w.id === selectedWorkflow.id ? { ...w, run_count: w.run_count + 1 } : w
    ));
    setShowRunConfirm(false);
  };

  useInput((input, key) => {
    if (showRunConfirm) return;

    if (key.escape) {
      if (selectedWorkflow) {
        setSelectedWorkflow(null);
      } else if (!embedded) {
        onBack();
      }
      return;
    }

    if (input === 'r' && selectedWorkflow) {
      setShowRunConfirm(true);
      return;
    }
  });

  // Step detail view
  if (selectedWorkflow) {
    const stepsText = selectedWorkflow.steps.map((step, i) => {
      const s = step as Record<string, unknown>;
      const type = (s.step_type || s.type || 'agent_prompt') as string;
      const action = (s.action || s.prompt || 'N/A') as string;
      const agentId = (s.agent_id || 'N/A') as string;
      return `Step ${i + 1}: [${type}]\n  Agent: ${agentId}\n  Action: ${action}`;
    }).join('\n\n');

    return (
      <Box flexDirection="column">
        <Text bold color="cyan">{selectedWorkflow.name}</Text>
        {selectedWorkflow.description && <Text color="gray">{selectedWorkflow.description}</Text>}
        <Text color="gray">{selectedWorkflow.steps.length} steps {'\u2022'} {selectedWorkflow.run_count} runs</Text>
        <Box marginTop={1}>
          <TextPanel content={stepsText} title="Workflow Steps" />
        </Box>
        <Box marginTop={1}>
          <Text color="gray">
            <Text bold color="white">r</Text>:run workflow  <Text bold color="white">Esc</Text>:back
          </Text>
        </Box>
        {showRunConfirm && (
          <ConfirmDialog
            message={`Run workflow "${selectedWorkflow.name}" (${selectedWorkflow.steps.length} steps)?`}
            onConfirm={() => runWorkflow()}
            onCancel={() => setShowRunConfirm(false)}
          />
        )}
      </Box>
    );
  }

  // List view
  return (
    <Box flexDirection="column">
      {!embedded && <Text bold>Workflows ({workflows.length})</Text>}
      <Box marginTop={1}>
        <ScrollableList
          items={workflows}
          onSelect={(w) => setSelectedWorkflow(w)}
          emptyMessage="No workflows configured. Create workflows from the web dashboard."
          renderItem={(workflow, _, isSelected) => (
            <Box>
              <Text bold={isSelected}>{workflow.name.slice(0, 25).padEnd(25)}</Text>
              <Text color={workflow.status === 'active' ? 'green' : 'gray'}>{workflow.status.padEnd(10)}</Text>
              <Text color="gray">{String(workflow.steps.length).padStart(3)} steps  </Text>
              <Text color="gray">{String(workflow.run_count).padStart(3)} runs</Text>
            </Box>
          )}
        />
      </Box>
      <Box marginTop={1}>
        <Text color="gray">
          <Text bold color="white">Enter</Text>:view steps{!embedded && <>{' '}<Text bold color="white">Esc</Text>:back</>}
        </Text>
      </Box>
    </Box>
  );
}
