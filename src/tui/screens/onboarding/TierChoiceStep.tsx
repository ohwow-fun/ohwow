/**
 * Onboarding Step: Tier Choice (Key Entry)
 * License key entry screen — shown when no saved key was found on splash.
 */

import React from 'react';
import { Box, Text } from 'ink';

interface TierChoiceStepProps {
  /** Current license key input value */
  licenseKey: string;
  /** Validation in progress */
  validating: boolean;
  /** Error message from validation */
  error: string;
}

export function TierChoiceStep({
  licenseKey,
  validating,
  error,
}: TierChoiceStepProps) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Enter your license key</Text>
      </Box>

      <Box>
        <Text color="cyan">{'> '}</Text>
        <Text>{licenseKey || ' '}</Text>
        {!validating && <Text color="gray">{'_'}</Text>}
      </Box>

      {validating && (
        <Box marginTop={1}>
          <Text color="yellow">Validating...</Text>
        </Box>
      )}

      {error && (
        <Box marginTop={1} flexDirection="column">
          <Text color="red">{error}</Text>
          <Box marginTop={1}>
            <Text color="gray">Press <Text bold color="white">Esc</Text> to go back</Text>
          </Box>
        </Box>
      )}

      {!validating && !error && (
        <Box marginTop={1}>
          <Text color="gray">Press <Text bold color="white">Enter</Text> to validate</Text>
        </Box>
      )}
    </Box>
  );
}
