/**
 * Agent Create Wizard
 * Step-based wizard for creating a new agent from the TUI.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { InputField } from '../components/input-field.js';
import { KeyHints } from '../components/key-hints.js';
import { logger } from '../../lib/logger.js';

interface AgentCreateWizardProps {
  db: DatabaseAdapter | null;
  workspaceId: string;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'name' | 'role' | 'prompt' | 'confirm' | 'creating' | 'done';
const STEPS: Step[] = ['name', 'role', 'prompt', 'confirm', 'creating', 'done'];

export function AgentCreateWizard({ db, workspaceId, onComplete, onCancel }: AgentCreateWizardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [name, setName] = useState('');
  const [role, setRole] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [error, setError] = useState('');
  const [showMcpHint, setShowMcpHint] = useState(false);

  const step = STEPS[stepIndex];
  const stepNum = stepIndex + 1;
  // Only count user-facing steps (exclude creating/done)
  const totalVisible = 4;

  const nextStep = () => {
    setError('');
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  };

  const prevStep = () => {
    setError('');
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  const handleCreate = async () => {
    if (!db) return;

    setStepIndex(STEPS.indexOf('creating'));
    setError('');

    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      const agentId = Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');

      await db.from('agent_workforce_agents').insert({
        id: agentId,
        workspace_id: workspaceId,
        name: name.trim(),
        role: role.trim(),
        system_prompt: systemPrompt.trim(),
        config: JSON.stringify({
          model: 'claude-sonnet-4-5',
          temperature: 0.7,
          max_tokens: 4096,
          tools_enabled: [],
          approval_required: false,
          web_search_enabled: true,
        }),
        status: 'idle',
        stats: JSON.stringify({
          total_tasks: 0,
          completed_tasks: 0,
          failed_tasks: 0,
          tokens_used: 0,
          cost_cents: 0,
        }),
        is_preset: false,
        memory_document: '',
        memory_token_count: 0,
      });

      // Log activity
      await db.rpc('create_agent_activity', {
        p_workspace_id: workspaceId,
        p_activity_type: 'agent_created',
        p_title: `${name.trim()} created from TUI`,
        p_description: `Role: ${role.trim()}`,
        p_agent_id: agentId,
        p_task_id: null,
        p_metadata: { runtime: true, source: 'tui' },
      });

      // Check if global MCP servers are configured
      try {
        const { data: mcpData } = await db
          .from('runtime_settings')
          .select('value')
          .eq('key', 'global_mcp_servers')
          .maybeSingle();

        const mcpServers = mcpData
          ? JSON.parse((mcpData as { value: string }).value)
          : [];
        if (!Array.isArray(mcpServers) || mcpServers.length === 0) {
          setShowMcpHint(true);
        }
      } catch (mcpErr) {
        logger.debug({ err: mcpErr }, 'Could not check global MCP servers');
      }

      setStepIndex(STEPS.indexOf('done'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
      setStepIndex(STEPS.indexOf('confirm'));
    }
  };

  useInput((_, key) => {
    if (key.escape) {
      if (step === 'creating') return;
      if (step === 'done') {
        onComplete();
        return;
      }
      if (stepIndex > 0) {
        prevStep();
      } else {
        onCancel();
      }
    }

    if (step === 'confirm' && key.return) {
      handleCreate();
    }

    if (step === 'done' && key.return) {
      onComplete();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">New Agent</Text>
        <Text color="gray"> — Step {Math.min(stepNum, totalVisible)} of {totalVisible}</Text>
      </Box>

      {/* Progress dots */}
      <Box marginBottom={1}>
        {STEPS.slice(0, totalVisible).map((_, i) => (
          <Text key={i} color={i < stepIndex ? 'green' : i === stepIndex ? 'cyan' : 'gray'}>
            {i < stepIndex ? '●' : i === stepIndex ? '◉' : '○'}{' '}
          </Text>
        ))}
      </Box>

      {step === 'name' && (
        <Box flexDirection="column">
          <Text bold>Agent Name</Text>
          <Text color="gray">What should this agent be called?</Text>
          <Box marginTop={1}>
            <InputField
              label="Name"
              value={name}
              onChange={setName}
              placeholder="e.g. Research Assistant"
              onSubmit={() => {
                if (!name.trim()) {
                  setError('Give your agent a name');
                  return;
                }
                nextStep();
              }}
            />
          </Box>
        </Box>
      )}

      {step === 'role' && (
        <Box flexDirection="column">
          <Text bold>Role</Text>
          <Text color="gray">What does this agent do? A short title for its job.</Text>
          <Box marginTop={1}>
            <InputField
              label="Role"
              value={role}
              onChange={setRole}
              placeholder="e.g. Content Writer, Data Analyst"
              onSubmit={() => {
                if (!role.trim()) {
                  setError('Give your agent a role');
                  return;
                }
                nextStep();
              }}
            />
          </Box>
        </Box>
      )}

      {step === 'prompt' && (
        <Box flexDirection="column">
          <Text bold>System Prompt</Text>
          <Text color="gray">Instructions that tell the agent how to behave and what to focus on.</Text>
          <Box marginTop={1}>
            <InputField
              label="Prompt"
              value={systemPrompt}
              onChange={setSystemPrompt}
              placeholder="You are a helpful assistant that..."
              onSubmit={() => {
                if (!systemPrompt.trim()) {
                  setError('Write a system prompt so the agent knows what to do');
                  return;
                }
                nextStep();
              }}
            />
          </Box>
        </Box>
      )}

      {step === 'confirm' && (
        <Box flexDirection="column">
          <Text bold>Review</Text>
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            <Text><Text bold>Name:</Text> {name}</Text>
            <Text><Text bold>Role:</Text> {role}</Text>
            <Text><Text bold>Prompt:</Text> {systemPrompt.length > 80 ? systemPrompt.slice(0, 80) + '...' : systemPrompt}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Press <Text bold color="white">Enter</Text> to create, <Text bold>Esc</Text> to edit</Text>
          </Box>
        </Box>
      )}

      {step === 'creating' && (
        <Box marginTop={1}>
          <Text color="yellow">Creating agent...</Text>
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column">
          <Text bold color="green">Agent created!</Text>
          <Text color="gray">{name} is ready to receive tasks.</Text>
          {showMcpHint && (
            <Box marginTop={1}>
              <Text color="yellow">Want to give your agents superpowers? Add an MCP server for GitHub, databases, and more. Press m in Settings.</Text>
            </Box>
          )}
          <Text color="gray">Press Esc to go back.</Text>
        </Box>
      )}

      {error && <Text color="red">{error}</Text>}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(stepIndex > 0 && step !== 'creating' && step !== 'done' ? [{ key: 'Esc', label: 'Back' }] : step === 'name' ? [{ key: 'Esc', label: 'Cancel' }] : []),
            ...(step === 'confirm' ? [{ key: 'Enter', label: 'Create' }] : []),
            ...(step === 'done' ? [{ key: 'Esc', label: 'Back' }] : []),
          ]}
        />
      </Box>
    </Box>
  );
}
