/**
 * Onboarding Step: First Moment
 * Two fields: business name + first task.
 * Replaces BusinessInfoStep + FounderStageStep.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { KeyHints } from '../../components/key-hints.js';

type Field = 'businessName' | 'firstTask';

interface FirstMomentStepProps {
  businessName: string;
  firstTask: string;
  activeField: Field;
}

export function FirstMomentStep({
  businessName,
  firstTask,
  activeField,
}: FirstMomentStepProps) {
  return (
    <Box flexDirection="column">
      {/* Business name */}
      <Box marginBottom={1} flexDirection="column">
        <Text color={activeField === 'businessName' ? 'cyan' : 'gray'}>
          What&apos;s your business called?
        </Text>
        <Box>
          {activeField === 'businessName' ? (
            <Box>
              <Text color="cyan">{'> '}</Text>
              <Text>{businessName || ' '}</Text>
              <Text color="cyan">▊</Text>
            </Box>
          ) : (
            <Text color={businessName ? 'white' : 'gray'}>
              {'  '}{businessName || '(not set)'}
            </Text>
          )}
        </Box>
      </Box>

      {/* First task */}
      <Box marginBottom={1} flexDirection="column">
        <Text color={activeField === 'firstTask' ? 'cyan' : 'gray'}>
          What should your first agent do?
        </Text>
        <Box>
          {activeField === 'firstTask' ? (
            <Box>
              <Text color="cyan">{'> '}</Text>
              <Text>{firstTask || ' '}</Text>
              <Text color="cyan">▊</Text>
            </Box>
          ) : (
            <Text color={firstTask ? 'white' : 'gray'}>
              {'  '}{firstTask || '(not set yet)'}
            </Text>
          )}
        </Box>
      </Box>

      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Enter', label: activeField === 'firstTask' ? 'Continue' : 'Next field' },
            { key: 'Esc', label: 'Back' },
          ]}
        />
      </Box>
    </Box>
  );
}
