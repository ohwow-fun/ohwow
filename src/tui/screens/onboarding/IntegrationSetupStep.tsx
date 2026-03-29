/**
 * Onboarding Step: Integration Setup
 * Collects API tokens for MCP servers required by selected agents.
 * Shown between Agent Selection and Ready when agents need integrations.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { KeyHints } from '../../components/key-hints.js';
import type { McpCatalogEntry } from '../../../mcp/catalog.js';

export interface IntegrationInput {
  server: McpCatalogEntry;
  envValues: Record<string, string>;
}

interface IntegrationSetupStepProps {
  integrations: IntegrationInput[];
  currentIndex: number;
  currentEnvIndex: number;
  currentValue: string;
  skippedIds: Set<string>;
}

export function IntegrationSetupStep({
  integrations,
  currentIndex,
  currentEnvIndex,
  currentValue,
  skippedIds,
}: IntegrationSetupStepProps) {
  if (integrations.length === 0) {
    return (
      <Box flexDirection="column">
        <Text bold>Integrations</Text>
        <Text color="gray">No integrations needed. Press Enter to continue.</Text>
      </Box>
    );
  }

  const current = integrations[currentIndex];
  const currentEnvVar = current.server.envVarsRequired[currentEnvIndex];
  const isConfigured = !!current.envValues[currentEnvVar?.key];

  return (
    <Box flexDirection="column">
      <Text bold>Connect integrations</Text>
      <Text color="gray">
        Some agents work best with connected services. You can skip any for now.
      </Text>

      <Box flexDirection="column" marginTop={1}>
        {integrations.map((integration, i) => {
          const isCurrent = i === currentIndex;
          const isSkipped = skippedIds.has(integration.server.id);
          const allConfigured = integration.server.envVarsRequired.every(
            env => !!integration.envValues[env.key],
          );

          return (
            <Box key={integration.server.id} marginBottom={1} flexDirection="column">
              <Box>
                <Text color={isCurrent ? 'cyan' : 'gray'}>
                  {isCurrent ? '> ' : '  '}
                </Text>
                <Text color={allConfigured ? 'green' : isSkipped ? 'yellow' : isCurrent ? 'white' : 'gray'}>
                  {allConfigured ? '[done] ' : isSkipped ? '[skip] ' : '[    ] '}
                </Text>
                <Text bold={isCurrent} color={isCurrent ? 'white' : 'gray'}>
                  {integration.server.name}
                </Text>
                <Text color="gray"> {integration.server.description}</Text>
              </Box>
            </Box>
          );
        })}
      </Box>

      {current && currentEnvVar && !skippedIds.has(current.server.id) && (
        <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
          <Text bold color="cyan">{current.server.name}</Text>
          <Text color="gray">{currentEnvVar.label}</Text>
          <Box marginTop={1}>
            <Text color="gray">{currentEnvVar.key}=</Text>
            <Text color="white">{currentValue || ''}</Text>
            <Text color={isConfigured ? 'green' : 'cyan'}>
              {isConfigured ? '' : '_'}
            </Text>
          </Box>
        </Box>
      )}

      <Box marginTop={1}>
        <KeyHints hints={[
          { key: 'Enter', label: 'Confirm' },
          { key: 's', label: 'Skip this' },
          { key: 'Esc', label: 'Back' },
        ]} />
      </Box>
    </Box>
  );
}
