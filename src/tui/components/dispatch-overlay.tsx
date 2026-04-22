/**
 * DispatchOverlay Component
 * Floating dispatch overlay triggered by `d` from any screen.
 * Two fields: task description (required) + @agent (optional).
 * Tab moves between fields, Enter queues the task, Escape dismisses.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { getEventBus } from '../hooks/use-event-bus.js';
import { C } from '../theme.js';

interface Agent {
  id: string;
  name: string;
  role: string;
}

interface DispatchOverlayProps {
  agents: Agent[];
  db: DatabaseAdapter | null;
  workspaceId: string;
  onClose: () => void;
}

type OverlayField = 'task' | 'agent';
type OverlayStatus = 'idle' | 'dispatching' | 'done' | 'error';

export function DispatchOverlay({ agents, db, workspaceId, onClose }: DispatchOverlayProps) {
  const [taskValue, setTaskValue] = useState('');
  const [agentValue, setAgentValue] = useState('');
  const [focusedField, setFocusedField] = useState<OverlayField>('task');
  const [status, setStatus] = useState<OverlayStatus>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  const [confirmedTitle, setConfirmedTitle] = useState('');

  // Auto-close after successful dispatch
  useEffect(() => {
    if (status !== 'done') return;
    const timer = setTimeout(() => onClose(), 1800);
    return () => clearTimeout(timer);
  }, [status, onClose]);

  const resolveAgent = (): Agent | null => {
    if (!agentValue.trim()) return agents[0] ?? null;
    const query = agentValue.replace(/^@/, '').trim().toLowerCase();
    return agents.find(a => a.name.toLowerCase().includes(query)) ?? agents[0] ?? null;
  };

  const dispatch = async () => {
    const title = taskValue.trim();
    if (!title) return;
    if (!db) {
      setErrorMsg("No database connection.");
      setStatus('error');
      return;
    }

    const agent = resolveAgent();
    if (!agent) {
      setErrorMsg("No agents available. Create one first.");
      setStatus('error');
      return;
    }

    setStatus('dispatching');

    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const taskId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

      const { data: agentData } = await db
        .from<{ workspace_id: string }>('agent_workforce_agents')
        .select('workspace_id')
        .eq('id', agent.id)
        .single();

      const wsId = agentData?.workspace_id || workspaceId;

      await db.from('agent_workforce_tasks').insert({
        id: taskId,
        workspace_id: wsId,
        agent_id: agent.id,
        title,
        description: null,
        input: title,
        status: 'pending',
      });

      await db.rpc('create_agent_activity', {
        p_workspace_id: wsId,
        p_activity_type: 'task_started',
        p_title: `${title} — dispatched via overlay`,
        p_description: `Agent: ${agent.name}`,
        p_agent_id: agent.id,
        p_task_id: taskId,
        p_metadata: { runtime: true, local_dispatch: true, via_overlay: true },
      });

      getEventBus().emit('task:started', { taskId, agentId: agent.id, title });

      setConfirmedTitle(title);
      setStatus('done');
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : "Couldn't dispatch task.");
      setStatus('error');
    }
  };

  useInput((input, key) => {
    if (status === 'dispatching') return;

    if (status === 'done' || status === 'error') {
      if (key.escape || key.return) onClose();
      return;
    }

    if (key.escape) {
      onClose();
      return;
    }

    if (key.tab) {
      setFocusedField(f => (f === 'task' ? 'agent' : 'task'));
      return;
    }

    // Enter dispatches from either field
    if (key.return) {
      void dispatch();
      return;
    }
  });

  const agentHint = (() => {
    if (!agentValue.trim()) {
      return agents[0] ? `default: ${agents[0].name}` : 'no agents';
    }
    const query = agentValue.replace(/^@/, '').trim().toLowerCase();
    const match = agents.find(a => a.name.toLowerCase().includes(query));
    return match ? `→ ${match.name}` : '◌ no match';
  })();

  return (
    <Box
      position="absolute"
      flexDirection="column"
      alignItems="center"
      justifyContent="center"
      width="100%"
    >
      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor={C.cyan}
        paddingX={2}
        paddingY={1}
        width={52}
      >
        {status === 'idle' && (
          <>
            <Text bold color={C.cyan}>◈ DISPATCH MISSION</Text>
            <Box marginTop={1} flexDirection="column">
              <Box>
                <Text color={focusedField === 'task' ? 'white' : 'gray'}>Task:  </Text>
                {focusedField === 'task' ? (
                  <TextInput
                    value={taskValue}
                    onChange={setTaskValue}
                    onSubmit={() => void dispatch()}
                    placeholder="describe what to do..."
                    focus
                  />
                ) : (
                  <Text dimColor>{taskValue || 'describe what to do...'}</Text>
                )}
              </Box>
              <Box marginTop={1}>
                <Text color={focusedField === 'agent' ? 'white' : 'gray'}>Agent: </Text>
                {focusedField === 'agent' ? (
                  <TextInput
                    value={agentValue}
                    onChange={setAgentValue}
                    onSubmit={() => void dispatch()}
                    placeholder="@agent (optional)"
                    focus
                  />
                ) : (
                  <Text dimColor>{agentValue || '@agent (optional)'}</Text>
                )}
                <Text dimColor>  {agentHint}</Text>
              </Box>
            </Box>
            <Box marginTop={1}>
              <Text dimColor>Tab switch   Enter dispatch   Esc dismiss</Text>
            </Box>
          </>
        )}

        {status === 'dispatching' && (
          <Text color="yellow">Dispatching...</Text>
        )}

        {status === 'done' && (
          <Box flexDirection="column">
            <Text color={C.mint} bold>◈ MISSION DISPATCHED</Text>
            <Text dimColor>→ {confirmedTitle}</Text>
          </Box>
        )}

        {status === 'error' && (
          <>
            <Text color="red" bold>Couldn't dispatch.</Text>
            <Text color="red">{errorMsg}</Text>
            <Text dimColor>Press Esc or Enter to close</Text>
          </>
        )}
      </Box>
    </Box>
  );
}
