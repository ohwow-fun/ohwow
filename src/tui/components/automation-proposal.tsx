/**
 * AutomationProposal Component
 * Renders a proposed automation as a formatted card in the TUI.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { AutomationProposalTUI } from '../hooks/use-orchestrator.js';

interface AutomationProposalProps {
  proposal: AutomationProposalTUI;
}

export function AutomationProposal({ proposal }: AutomationProposalProps) {
  const schedule = proposal.trigger.config?.cron as string | undefined;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} marginY={1}>
      <Box marginBottom={1}>
        <Text color="cyan" bold>{proposal.name}</Text>
        <Text color="gray"> | </Text>
        <Text color="gray">{proposal.trigger.type}</Text>
      </Box>

      {proposal.description && (
        <Box marginBottom={1}>
          <Text wrap="wrap">{proposal.description}</Text>
        </Box>
      )}

      {schedule && (
        <Box marginBottom={1}>
          <Text color="gray">Schedule: </Text>
          <Text>{schedule}</Text>
        </Box>
      )}

      {proposal.steps.length > 0 && (
        <Box flexDirection="column" marginBottom={proposal.missingIntegrations.length > 0 ? 1 : 0}>
          <Text color="gray" dimColor>Steps:</Text>
          {proposal.steps.map((step, i) => (
            <Box key={step.id || i} flexDirection="column">
              <Box>
                <Text color="gray">{`  ${i + 1}. `}</Text>
                {step.agent_name && <Text bold>{step.agent_name} </Text>}
                <Text color="gray">[{step.step_type}] </Text>
                <Text wrap="wrap">{step.label}</Text>
              </Box>
              {step.warning && (
                <Box>
                  <Text color="yellow">     {step.warning}</Text>
                </Box>
              )}
            </Box>
          ))}
        </Box>
      )}

      {proposal.missingIntegrations.length > 0 && (
        <Box>
          <Text color="yellow">Missing integrations: {proposal.missingIntegrations.join(', ')}</Text>
        </Box>
      )}
    </Box>
  );
}
