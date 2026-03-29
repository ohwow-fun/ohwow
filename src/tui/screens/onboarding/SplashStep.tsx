/**
 * Onboarding Step 1: Splash
 * ASCII logo + tagline + "Get Started" prompt.
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { LicenseErrorKind } from '../../../control-plane/validate-license.js';

interface SplashStepProps {
  /** When set, shows "Welcome back" variant instead of first-run tagline */
  businessName?: string;
  /** When true, shows a "Checking your license..." indicator */
  loading?: boolean;
  /** When set, shows an error message (e.g. license validation failed) */
  error?: string;
  /** Classifies the error for context-aware messaging and actions */
  errorKind?: LicenseErrorKind;
}

export function SplashStep({ businessName, loading, error, errorKind }: SplashStepProps) {
  const isReturning = !!businessName;

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        <Text bold color="cyan">{'________    ___ ___  __      __________  __      __'}</Text>
        <Text bold color="cyan">{'\\_____  \\  /   |   \\/  \\    /  \\_____  \\/  \\    /  \\'}</Text>
        <Text bold color="cyan">{' /   |   \\/    ~    \\   \\/\\/   //   |   \\   \\/\\/   /'}</Text>
        <Text bold color="cyan">{'/    |    \\    Y    /\\        //    |    \\        /'}</Text>
        <Text bold color="cyan">{'\\_______  /\\___|_  /  \\__/\\  / \\_______  /\\__/\\  /'}</Text>
        <Text bold color="cyan">{'        \\/       \\/        \\/          \\/      \\/'}</Text>
      </Box>
      {loading ? (
        <Box marginTop={2}>
          <Text color="yellow">Checking your license...</Text>
        </Box>
      ) : isReturning ? (
        <>
          <Box marginTop={1}>
            <Text bold>Welcome back, <Text color="cyan">{businessName}</Text></Text>
          </Box>
          <Box marginTop={2}>
            <Text color="gray">Press <Text bold color="white">Enter</Text> to continue</Text>
          </Box>
          <Box marginTop={0}>
            <Text color="gray" dimColor>Press <Text bold dimColor>s</Text> to skip to dashboard</Text>
          </Box>
        </>
      ) : error ? (
        <>
          <Box marginTop={1}>
            <Text color="red">
              {errorKind === 'expired' ? 'Your license has expired.'
                : errorKind === 'network' ? 'Could not reach the cloud. You may be offline.'
                : errorKind === 'invalid' ? 'Your saved license key is no longer valid.'
                : error}
            </Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text color="gray">Press <Text bold color="white">l</Text> to continue in local mode</Text>
            <Text color="gray">Press <Text bold color="white">Enter</Text> to enter a different key</Text>
            {(errorKind === 'expired' || errorKind === 'device_conflict') && (
              <Text color="gray">Press <Text bold color="white">d</Text> to open the cloud dashboard</Text>
            )}
          </Box>
          <Box marginTop={1}>
            <Text color="gray" dimColor>Your agents and data will be preserved</Text>
          </Box>
        </>
      ) : (
        <>
          <Box marginTop={1}>
            <Text bold>Your AI team, running on your machine.</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">No account needed. No cloud required.</Text>
          </Box>
          <Box marginTop={2}>
            <Text color="gray">Press <Text bold color="white">Enter</Text> to get started</Text>
          </Box>
          <Box marginTop={0}>
            <Text color="gray" dimColor>Press <Text bold dimColor>s</Text> to skip and set up later</Text>
          </Box>
          <Box marginTop={2}>
            <Text color="gray" dimColor>Free forever for local use</Text>
          </Box>
        </>
      )}
    </Box>
  );
}
