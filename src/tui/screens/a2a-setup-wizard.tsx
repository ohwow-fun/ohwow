/**
 * A2A Setup Wizard
 * Step-based wizard for adding a new A2A connection.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import type { DatabaseAdapter } from '../../db/adapter-types.js';
import { fetchAgentCard, healthCheck, parseConnectionRow } from '../../a2a/client.js';
import type { A2AAgentCard, A2ATrustLevel } from '../../a2a/types.js';
import { InputField } from '../components/input-field.js';
import { KeyHints } from '../components/key-hints.js';

interface A2ASetupWizardProps {
  db: DatabaseAdapter | null;
  workspaceId: string;
  onComplete: () => void;
  onCancel: () => void;
}

type Step = 'url' | 'preview' | 'trust' | 'auth' | 'name' | 'validate' | 'done';
const STEPS: Step[] = ['url', 'preview', 'trust', 'auth', 'name', 'validate', 'done'];

const TRUST_LEVEL_OPTIONS = [
  { label: 'Read Only — Can view agents and task results', value: 'read_only' },
  { label: 'Execute — Can create and view tasks', value: 'execute' },
  { label: 'Autonomous — Full task management including cancellation', value: 'autonomous' },
  { label: 'Admin — Full access to all capabilities', value: 'admin' },
];

export function A2ASetupWizard({ db, workspaceId, onComplete, onCancel }: A2ASetupWizardProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const [cardUrl, setCardUrl] = useState('');
  const [card, setCard] = useState<A2AAgentCard | null>(null);
  const [trustLevel, setTrustLevel] = useState<A2ATrustLevel>('execute');
  const [authType, setAuthType] = useState<'none' | 'api_key' | 'bearer_token'>('none');
  const [authValue, setAuthValue] = useState('');
  const [connectionName, setConnectionName] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [validationResult, setValidationResult] = useState<{ healthy: boolean; latencyMs: number; error?: string } | null>(null);

  const step = STEPS[stepIndex];
  const stepNum = stepIndex + 1;

  const nextStep = () => {
    setError('');
    setStepIndex((i) => Math.min(i + 1, STEPS.length - 1));
  };

  const prevStep = () => {
    setError('');
    setStepIndex((i) => Math.max(i - 1, 0));
  };

  // Fetch agent card when advancing to preview
  const fetchCard = async () => {
    let url = cardUrl.trim();
    if (!url) {
      setError('URL is required');
      return;
    }

    // Auto-append well-known path if not present
    if (!url.includes('/.well-known/agent-card.json')) {
      url = url.replace(/\/$/, '') + '/.well-known/agent-card.json';
      setCardUrl(url);
    }

    setLoading(true);
    setError('');
    try {
      const agentCard = await fetchAgentCard(url);
      setCard(agentCard);
      setConnectionName(agentCard.name);

      // Detect auth requirement
      if (agentCard.authentication?.schemes?.includes('apiKey')) {
        setAuthType('api_key');
      } else if (agentCard.authentication?.schemes?.includes('bearer')) {
        setAuthType('bearer_token');
      } else {
        setAuthType('none');
      }

      nextStep();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch agent card');
    } finally {
      setLoading(false);
    }
  };

  // Validate and save
  const validateAndSave = async () => {
    if (!db || !card) return;
    setLoading(true);
    setError('');

    const endpointUrl = card.url;
    const authConfig: Record<string, unknown> = {};
    if (authType === 'api_key') authConfig.api_key = authValue;
    if (authType === 'bearer_token') authConfig.token = authValue;

    // Insert connection
    await db.from('a2a_connections').insert({
      workspace_id: workspaceId,
      name: connectionName,
      description: card.description || null,
      agent_card_url: cardUrl,
      endpoint_url: endpointUrl,
      auth_type: authType,
      auth_config: JSON.stringify(authConfig),
      trust_level: trustLevel,
      status: 'pending',
      agent_card_cache: JSON.stringify(card),
      agent_card_fetched_at: new Date().toISOString(),
    });

    // Run health check
    const { data } = await db.from('a2a_connections').select('*').eq('workspace_id', workspaceId).eq('agent_card_url', cardUrl).single();
    if (data) {
      const conn = parseConnectionRow(data as Record<string, unknown>);
      const result = await healthCheck(conn, db);
      setValidationResult(result);

      if (result.healthy) {
        nextStep();
      } else {
        setError(`Health check failed: ${result.error}`);
      }
    }

    setLoading(false);
  };

  // Auto-validate when reaching validation step
  useEffect(() => {
    if (step === 'validate' && !loading && !validationResult) {
      validateAndSave();
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  useInput((input, key) => {
    if (key.escape) {
      if (stepIndex > 0) {
        prevStep();
      } else {
        onCancel();
      }
    }

    if (step === 'preview' && key.return) {
      nextStep();
    }

    if (step === 'auth' && authType === 'none' && key.return) {
      nextStep();
    }

    if (step === 'done' && key.return) {
      onComplete();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyan">Add A2A Connection</Text>
        <Text color="gray"> — Step {stepNum} of {STEPS.length}</Text>
      </Box>

      {/* Progress dots */}
      <Box marginBottom={1}>
        {STEPS.map((_, i) => (
          <Text key={i} color={i < stepIndex ? 'green' : i === stepIndex ? 'cyan' : 'gray'}>
            {i < stepIndex ? '●' : i === stepIndex ? '◉' : '○'}{' '}
          </Text>
        ))}
      </Box>

      {/* Step content */}
      {step === 'url' && (
        <Box flexDirection="column">
          <Text bold>Agent Card URL</Text>
          <Text color="gray">Enter the base URL of the external agent (we&apos;ll append /.well-known/agent-card.json).</Text>
          <Box marginTop={1}>
            <InputField
              label="URL"
              value={cardUrl}
              onChange={setCardUrl}
              placeholder="https://agent.example.com"
              onSubmit={fetchCard}
            />
          </Box>
          {loading && <Text color="yellow">Fetching agent card...</Text>}
        </Box>
      )}

      {step === 'preview' && card && (
        <Box flexDirection="column">
          <Text bold>Agent Preview</Text>
          <Box flexDirection="column" marginTop={1} paddingX={1}>
            <Text><Text bold>Name:</Text> {card.name}</Text>
            <Text><Text bold>Description:</Text> {card.description}</Text>
            <Text><Text bold>Version:</Text> {card.version}</Text>
            <Text><Text bold>Endpoint:</Text> {card.url}</Text>
            <Text><Text bold>Auth:</Text> {card.authentication?.schemes?.join(', ') || 'none'}</Text>
            <Text><Text bold>Streaming:</Text> {card.capabilities?.streaming ? 'Yes' : 'No'}</Text>
            {card.skills.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text bold>Skills:</Text>
                {card.skills.map((s, i) => (
                  <Text key={i} color="gray">  • {s.name} — {s.description}</Text>
                ))}
              </Box>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">Press Enter to continue.</Text>
          </Box>
        </Box>
      )}

      {step === 'trust' && (
        <Box flexDirection="column">
          <Text bold>Trust Level</Text>
          <Text color="gray">Choose how much access this external agent has.</Text>
          <Box marginTop={1}>
            <SelectInput
              items={TRUST_LEVEL_OPTIONS}
              onSelect={(item) => {
                setTrustLevel(item.value as A2ATrustLevel);
                nextStep();
              }}
            />
          </Box>
        </Box>
      )}

      {step === 'auth' && (
        <Box flexDirection="column">
          <Text bold>Authentication</Text>
          {authType === 'none' ? (
            <Box flexDirection="column">
              <Text color="gray">No authentication required by this agent.</Text>
              <Text color="gray">Press Enter to continue.</Text>
            </Box>
          ) : (
            <Box flexDirection="column">
              <Text color="gray">
                This agent requires <Text bold>{authType === 'api_key' ? 'API Key' : 'Bearer Token'}</Text> authentication.
              </Text>
              <Box marginTop={1}>
                <InputField
                  label={authType === 'api_key' ? 'API Key' : 'Token'}
                  value={authValue}
                  onChange={setAuthValue}
                  mask="*"
                  onSubmit={nextStep}
                />
              </Box>
            </Box>
          )}
        </Box>
      )}

      {step === 'name' && (
        <Box flexDirection="column">
          <Text bold>Connection Name</Text>
          <Text color="gray">Give this connection a name (pre-filled from agent card).</Text>
          <Box marginTop={1}>
            <InputField
              label="Name"
              value={connectionName}
              onChange={setConnectionName}
              onSubmit={() => {
                if (!connectionName.trim()) {
                  setError('Name is required');
                  return;
                }
                nextStep();
              }}
            />
          </Box>
        </Box>
      )}

      {step === 'validate' && (
        <Box flexDirection="column">
          <Text bold>Validating Connection...</Text>
          {loading && <Text color="yellow">Running health check...</Text>}
          {validationResult && (
            <Text color={validationResult.healthy ? 'green' : 'red'}>
              {validationResult.healthy
                ? `✓ Connection healthy (${validationResult.latencyMs}ms)`
                : `✗ Health check failed: ${validationResult.error}`}
            </Text>
          )}
          {!loading && validationResult && !validationResult.healthy && (
            <Text color="gray">Press Esc to go back and fix settings.</Text>
          )}
        </Box>
      )}

      {step === 'done' && (
        <Box flexDirection="column">
          <Text bold color="green">Connection Added!</Text>
          <Text color="gray">
            {connectionName} is now connected and ready to receive tasks.
          </Text>
          <Text color="gray">Press Enter to return to connections list.</Text>
        </Box>
      )}

      {error && <Text color="red">{error}</Text>}

      <Box marginTop={1}>
        <KeyHints
          hints={[
            ...(stepIndex > 0 ? [{ key: 'Esc', label: 'Back' }] : [{ key: 'Esc', label: 'Cancel' }]),
            ...(step === 'preview' || (step === 'auth' && authType === 'none') ? [{ key: 'Enter', label: 'Continue' }] : []),
            ...(step === 'done' ? [{ key: 'Enter', label: 'Done' }] : []),
          ]}
        />
      </Box>
    </Box>
  );
}
