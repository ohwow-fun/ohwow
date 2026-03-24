/**
 * Onboarding Sub-step: Cloud Authentication
 * Shown when modelSource === 'cloud' and user isn't authenticated yet.
 * Supports API key entry and (future) OAuth browser flow.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { KeyHints } from '../../components/key-hints.js';

type CloudAuthMode = 'choose' | 'api_key' | 'oauth_waiting' | 'authenticated';

interface CloudAuthStepProps {
  mode: CloudAuthMode;
  apiKeyInput: string;
  validating: boolean;
  error: string;
  choiceIndex: number;
}

export function CloudAuthStep({ mode, apiKeyInput, validating, error, choiceIndex }: CloudAuthStepProps) {
  if (mode === 'authenticated') {
    return (
      <Box flexDirection="column">
        <Text bold color="green">Connected to Claude</Text>
        <Box marginTop={1}>
          <Text color="gray">Your API key is valid. Press Enter to continue.</Text>
        </Box>
        <Box marginTop={1}>
          <KeyHints hints={[{ key: 'Enter', label: 'Continue' }]} />
        </Box>
      </Box>
    );
  }

  if (mode === 'oauth_waiting') {
    return (
      <Box flexDirection="column">
        <Text bold>Waiting for browser...</Text>
        <Box marginTop={1}>
          <Text color="gray">A browser window should have opened. Complete the sign-in there.</Text>
        </Box>
        <Box marginTop={1}>
          <Text color="yellow">⟳ Waiting for authentication...</Text>
        </Box>
        <Box marginTop={1}>
          <KeyHints hints={[{ key: 'Esc', label: 'Cancel' }]} />
        </Box>
      </Box>
    );
  }

  if (mode === 'api_key') {
    return (
      <Box flexDirection="column">
        <Text bold>Connect to Claude</Text>
        <Box marginTop={1} flexDirection="column">
          <Text color="gray">Paste your Anthropic API key:</Text>
          <Box marginTop={1}>
            <Text color="cyan">API key: </Text>
            <Text>{apiKeyInput ? maskApiKey(apiKeyInput) : ''}</Text>
            <Text color="cyan">█</Text>
          </Box>
        </Box>
        {validating && (
          <Box marginTop={1}>
            <Text color="yellow">Validating key...</Text>
          </Box>
        )}
        {error && (
          <Box marginTop={1}>
            <Text color="red">{error}</Text>
          </Box>
        )}
        <Box marginTop={1}>
          <KeyHints hints={[
            { key: 'Enter', label: 'Confirm' },
            { key: 'Esc', label: 'Back' },
          ]} />
        </Box>
      </Box>
    );
  }

  // mode === 'choose'
  const choices = [
    { label: 'Paste API key', description: 'Enter your Anthropic API key' },
    { label: 'Sign in with browser', description: 'OAuth flow (coming soon)' },
  ];

  return (
    <Box flexDirection="column">
      <Text bold>Connect to Claude</Text>
      <Box flexDirection="column" marginTop={1}>
        {choices.map((choice, idx) => (
          <Box key={choice.label}>
            <Text color={idx === choiceIndex ? 'cyan' : 'gray'}>
              {idx === choiceIndex ? '▸ ' : '  '}
              {choice.label}
            </Text>
            {idx === 1 && <Text color="gray" dimColor> (coming soon)</Text>}
          </Box>
        ))}
      </Box>
      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <KeyHints hints={[
          { key: 'Enter', label: 'Select' },
          { key: 'Esc', label: 'Back' },
        ]} />
      </Box>
    </Box>
  );
}

function maskApiKey(key: string): string {
  if (key.length <= 8) return '•'.repeat(key.length);
  return key.slice(0, 7) + '•'.repeat(Math.min(key.length - 7, 20));
}
