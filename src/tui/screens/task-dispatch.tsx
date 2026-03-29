/**
 * TaskDispatch Screen
 * Create and dispatch a new task to an agent.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import type { RuntimeEngine } from '../../execution/engine.js';
import { InputField } from '../components/input-field.js';
import { getEventBus } from '../hooks/use-event-bus.js';

interface Agent {
  id: string;
  name: string;
  role: string;
}

interface TaskDispatchProps {
  agents: Agent[];
  db: DatabaseAdapter | null;
  engine: RuntimeEngine | null;
  tier?: string;
  modelReady?: boolean;
  onBack: () => void;
}

type DispatchStep = 'select-agent' | 'title' | 'description' | 'confirm' | 'dispatching' | 'done';

export function TaskDispatch({ agents, db, engine, tier, modelReady, onBack }: TaskDispatchProps) {
  const [step, setStep] = useState<DispatchStep>('select-agent');
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');

  useInput((_, key) => {
    if (key.escape) {
      if (step === 'select-agent') {
        onBack();
      } else if (step === 'done') {
        onBack();
      } else {
        // Go back one step
        if (step === 'title') setStep('select-agent');
        else if (step === 'description') setStep('title');
        else if (step === 'confirm') setStep('description');
      }
    }
  });

  const handleDispatch = async () => {
    if (!db || !engine || !selectedAgent) return;

    setStep('dispatching');
    try {
      // Generate task ID
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const taskId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

      // Get workspace from agent
      const { data: agentData } = await db
        .from<{ workspace_id: string }>('agent_workforce_agents')
        .select('workspace_id')
        .eq('id', selectedAgent.id)
        .single();

      const workspaceId = agentData?.workspace_id || '';

      // Create task in DB
      await db.from('agent_workforce_tasks').insert({
        id: taskId,
        workspace_id: workspaceId,
        agent_id: selectedAgent.id,
        title,
        description: description || null,
        input: description || title,
        status: 'queued',
      });

      // Log activity
      await db.rpc('create_agent_activity', {
        p_workspace_id: workspaceId,
        p_activity_type: 'task_started',
        p_title: `${title} — dispatched locally`,
        p_description: `Agent: ${selectedAgent.name}`,
        p_agent_id: selectedAgent.id,
        p_task_id: taskId,
        p_metadata: { runtime: true, local_dispatch: true },
      });

      // Execute task
      getEventBus().emit('task:started', { taskId, agentId: selectedAgent.id, title });

      engine.executeTask(selectedAgent.id, taskId).then(result => {
        if (result.success) {
          getEventBus().emit('task:completed', {
            taskId,
            agentId: selectedAgent.id,
            status: result.status,
            tokensUsed: result.tokensUsed,
            costCents: result.costCents,
          });
        } else {
          getEventBus().emit('task:failed', {
            taskId,
            agentId: selectedAgent.id,
            error: result.error || 'Unknown error',
          });
        }
      }).catch(err => {
        getEventBus().emit('task:failed', {
          taskId,
          agentId: selectedAgent.id,
          error: err instanceof Error ? err.message : 'Unknown',
        });
      });

      setStep('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't dispatch task");
      setStep('confirm');
    }
  };

  if (tier === 'free' && !modelReady) {
    return (
      <Box flexDirection="column">
        <Text bold>New Task</Text>
        <Text color="yellow" bold>Local AI not set up yet.</Text>
        <Text color="gray">Press <Text bold color="white">o</Text> to set up local AI.</Text>
        <Text color="gray">{'\n'}Press Esc to go back.</Text>
      </Box>
    );
  }

  if (agents.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>New Task</Text>
        <Text color="gray">No agents yet. Press Esc, then c to create one.</Text>
        <Text color="gray">{'\n'}Press Esc to go back.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold>New Task</Text>

      {step === 'select-agent' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Select an agent:</Text>
          <SelectInput
            items={agents.map(a => ({ label: `${a.name} (${a.role})`, value: a.id }))}
            onSelect={(item) => {
              const agent = agents.find(a => a.id === item.value);
              if (agent) {
                setSelectedAgent(agent);
                setStep('title');
              }
            }}
          />
        </Box>
      )}

      {step === 'title' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Agent: <Text bold>{selectedAgent?.name}</Text></Text>
          <Box marginTop={1}>
            <InputField
              label="Task Title"
              value={title}
              onChange={setTitle}
              onSubmit={() => {
                if (!title.trim()) {
                  setError('Title is required');
                  return;
                }
                setError('');
                setStep('description');
              }}
            />
          </Box>
          {error && <Text color="red">{error}</Text>}
        </Box>
      )}

      {step === 'description' && (
        <Box flexDirection="column" marginTop={1}>
          <Text color="gray">Agent: <Text bold>{selectedAgent?.name}</Text></Text>
          <Text color="gray">Title: <Text bold>{title}</Text></Text>
          <Box marginTop={1}>
            <InputField
              label="Description (optional, Enter to skip)"
              value={description}
              onChange={setDescription}
              onSubmit={() => setStep('confirm')}
            />
          </Box>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold>Confirm Task Dispatch</Text>
          <Text>Agent:       <Text color="cyan">{selectedAgent?.name}</Text></Text>
          <Text>Title:       <Text>{title}</Text></Text>
          {description && <Text>Description: <Text color="gray">{description}</Text></Text>}
          <Box marginTop={1}>
            <Text color="gray">Press <Text bold color="white">Enter</Text> to dispatch, <Text bold>Esc</Text> to edit</Text>
          </Box>
          {error && <Text color="red">{error}</Text>}
          <ConfirmInput onConfirm={handleDispatch} />
        </Box>
      )}

      {step === 'dispatching' && (
        <Box marginTop={1}>
          <Text color="yellow">Dispatching task...</Text>
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column" marginTop={1}>
          <Text bold color="green">Task dispatched!</Text>
          <Text color="gray">The task is now running. Press Esc to go back to tasks.</Text>
        </Box>
      )}
    </Box>
  );
}

function ConfirmInput({ onConfirm }: { onConfirm: () => void }) {
  useInput((_, key) => {
    if (key.return) {
      onConfirm();
    }
  });
  return null;
}
