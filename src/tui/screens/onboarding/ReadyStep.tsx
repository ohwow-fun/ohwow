/**
 * Onboarding Step 7: Ready
 * Summary + Launch button.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { OllamaModelInfo } from '../../../lib/ollama-models.js';

export interface HealthSummary {
  totalTasks: number;
  totalCostCents: number;
  agentErrors: number;
  agentCount: number;
  modelReady: boolean;
  modelName?: string;
}

interface ReadyStepProps {
  businessName: string;
  selectedModel: OllamaModelInfo | null;
  agentCount: number;
  /** When set, renders an extended readiness summary for returning users */
  healthSummary?: HealthSummary;
}

export function ReadyStep({ businessName, selectedModel, agentCount, healthSummary }: ReadyStepProps) {
  if (healthSummary) {
    const readyCount = healthSummary.agentCount - healthSummary.agentErrors;
    const agentSummary = healthSummary.agentErrors > 0
      ? `${readyCount} ready, ${healthSummary.agentErrors} ${healthSummary.agentErrors === 1 ? 'error' : 'errors'}`
      : `${healthSummary.agentCount} ready`;

    return (
      <Box flexDirection="column">
        <Text bold color="green">Ready</Text>

        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
          {businessName && (
            <Text>
              <Text color="gray">Business:  </Text>
              <Text color="white" bold>{businessName}</Text>
            </Text>
          )}
          <Text>
            <Text color="gray">Model:     </Text>
            {healthSummary.modelReady ? (
              <Text color="green">✓ <Text color="white">{healthSummary.modelName || selectedModel?.label || 'Unknown'}</Text></Text>
            ) : (
              <Text color="yellow">Not configured</Text>
            )}
          </Text>
          <Text>
            <Text color="gray">Agents:    </Text>
            <Text color="white">{agentSummary}</Text>
          </Text>
          <Text>
            <Text color="gray">Tasks:     </Text>
            <Text color="white">{healthSummary.totalTasks} completed</Text>
          </Text>
          <Text>
            <Text color="gray">Cost:      </Text>
            <Text color="white">${(healthSummary.totalCostCents / 100).toFixed(2)}</Text>
          </Text>
        </Box>

        <Box marginTop={2}>
          <Text color="gray">Press <Text bold color="white">Enter</Text> to continue to dashboard</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text bold color="green">Your team is getting started.</Text>

      <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="green" paddingX={2} paddingY={1}>
        {businessName && (
          <Text>
            <Text color="gray">Business: </Text>
            <Text color="white" bold>{businessName}</Text>
          </Text>
        )}
        <Text>
          <Text color="gray">Model: </Text>
          <Text color="white">{selectedModel?.label || 'None (you can add one later)'}</Text>
        </Text>
        <Text>
          <Text color="gray">Agents: </Text>
          <Text color="white">
            {agentCount > 0 ? `${agentCount} agent${agentCount === 1 ? '' : 's'} ready to go` : 'None selected'}
          </Text>
        </Text>
      </Box>

      {!selectedModel && (
        <Box marginTop={1}>
          <Text color="yellow">You can download a model later from Settings.</Text>
        </Box>
      )}

      <Box marginTop={2}>
        <Text color="gray">Press <Text bold color="white">Enter</Text> to open the dashboard.</Text>
      </Box>
    </Box>
  );
}
