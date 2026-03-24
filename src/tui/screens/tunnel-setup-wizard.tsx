/**
 * Tunnel Setup Wizard
 * Guided flow to enable Cloudflare tunnel for webhook URLs.
 * Steps: explain → starting → done
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { KeyHints } from '../components/key-hints.js';
import { updateConfigFile } from '../../config.js';

type WizardStep = 'explain' | 'starting' | 'error' | 'done';

interface TunnelSetupWizardProps {
  port: number;
  tunnelUrl: string | null;
  cloudWebhookBaseUrl: string | null;
  onStartTunnel: () => Promise<void>;
  onStopTunnel: () => void;
  onComplete: () => void;
  onCancel: () => void;
}

export function TunnelSetupWizard({
  port,
  tunnelUrl,
  cloudWebhookBaseUrl,
  onStartTunnel,
  onStopTunnel,
  onComplete,
  onCancel,
}: TunnelSetupWizardProps) {
  const [step, setStep] = useState<WizardStep>(tunnelUrl ? 'done' : 'explain');
  const [error, setError] = useState('');
  const [alwaysEnable, setAlwaysEnable] = useState(false);

  const doStart = async () => {
    setError('');
    setStep('starting');
    try {
      await onStartTunnel();
      setStep('done');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      if (msg.includes('cloudflared') || msg.includes('Cannot find module') || msg.includes('MODULE_NOT_FOUND')) {
        setError(
          'The "cloudflared" npm package is not installed.\n' +
          'Run: npm install cloudflared\n' +
          'Then try again.',
        );
      } else {
        setError(msg);
      }
      setStep('error');
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    if (step === 'explain' && key.return) {
      doStart();
      return;
    }

    if (step === 'error' && input === 'r') {
      doStart();
      return;
    }

    if (step === 'done') {
      if (input === 'a') {
        setAlwaysEnable(!alwaysEnable);
        return;
      }
      if (input === 'd') {
        onStopTunnel();
        onCancel();
        return;
      }
      if (key.return) {
        if (alwaysEnable) {
          updateConfigFile({ tunnelEnabled: true });
        }
        onComplete();
        return;
      }
    }
  });

  const steps: WizardStep[] = ['explain', 'starting', 'done'];
  const stepIdx = steps.indexOf(step === 'error' ? 'starting' : step);

  return (
    <Box flexDirection="column" padding={1}>
      {/* Header */}
      <Box marginBottom={1}>
        <Text bold color="cyan">Tunnel Setup</Text>
        <Text color="gray"> | Step {stepIdx + 1} of {steps.length}</Text>
      </Box>

      {/* Progress dots */}
      <Box marginBottom={1}>
        {steps.map((s, i) => (
          <Text key={s} color={i < stepIdx ? 'green' : i === stepIdx ? 'cyan' : 'gray'}>
            {i < stepIdx ? '●' : i === stepIdx ? '◉' : '○'}{' '}
          </Text>
        ))}
      </Box>

      {/* Step: explain */}
      {step === 'explain' && (
        <Box flexDirection="column">
          <Text bold>What is a tunnel?</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">
              A tunnel creates a temporary public URL so external services
            </Text>
            <Text color="gray">
              (like GHL, Stripe, or other webhooks) can reach your local workspace.
            </Text>
            <Text color="gray">
              The URL changes each time you restart.
            </Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">
              Your local server on port <Text color="white" bold>{port}</Text> will be exposed via Cloudflare.
            </Text>
            <Text color="gray">
              No account or setup needed. It uses a free quick tunnel.
            </Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">
              Press <Text bold color="white">Enter</Text> to start the tunnel, <Text bold color="white">Esc</Text> to cancel.
            </Text>
          </Box>
        </Box>
      )}

      {/* Step: starting */}
      {step === 'starting' && (
        <Box flexDirection="column">
          <Text bold>Starting tunnel...</Text>
          <Box marginTop={1}>
            <Text color="yellow">Connecting to Cloudflare. This usually takes 5 to 10 seconds.</Text>
          </Box>
        </Box>
      )}

      {/* Step: error */}
      {step === 'error' && (
        <Box flexDirection="column">
          <Text bold color="red">Tunnel could not start</Text>
          <Box flexDirection="column" marginTop={1}>
            {error.split('\n').map((line, i) => (
              <Text key={i} color="gray">{line}</Text>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text color="gray">
              Press <Text bold color="white">r</Text> to retry, <Text bold color="white">Esc</Text> to go back.
            </Text>
          </Box>
        </Box>
      )}

      {/* Step: done */}
      {step === 'done' && tunnelUrl && (
        <Box flexDirection="column">
          <Text bold color="green">Tunnel is active!</Text>
          <Box flexDirection="column" marginTop={1}>
            <Text>{'  Public URL:  '}<Text color="cyan" bold>{tunnelUrl}</Text></Text>
            <Text>{'  Webhook:     '}<Text color={cloudWebhookBaseUrl ? 'cyan' : 'gray'}>{cloudWebhookBaseUrl ? `${cloudWebhookBaseUrl}/ghl` : `${tunnelUrl}/webhooks/ghl`}</Text></Text>
          </Box>
          <Box flexDirection="column" marginTop={1}>
            <Text color="gray">Copy the webhook URL and paste it into your external service.</Text>
          </Box>
          <Box marginTop={1}>
            <Text>
              {'  '}
              <Text color={alwaysEnable ? 'green' : 'gray'}>
                {alwaysEnable ? '[✓]' : '[ ]'}
              </Text>
              {' Start tunnel automatically on every launch'}
            </Text>
            <Text color="gray">{'      Press '}<Text bold color="white">a</Text>{' to toggle'}</Text>
          </Box>
          <Box marginTop={1}>
            <Text color="gray">
              Press <Text bold color="white">Enter</Text> to finish, <Text bold color="white">d</Text> to disable and go back.
            </Text>
          </Box>
        </Box>
      )}

      {/* Key hints */}
      <Box marginTop={1}>
        <KeyHints
          hints={[
            { key: 'Esc', label: 'Cancel' },
            ...(step === 'explain' ? [{ key: 'Enter', label: 'Start tunnel' }] : []),
            ...(step === 'error' ? [{ key: 'r', label: 'Retry' }] : []),
            ...(step === 'done' ? [
              { key: 'a', label: 'toggle auto-start' },
              { key: 'Enter', label: 'Finish' },
              { key: 'd', label: 'disable' },
            ] : []),
          ]}
        />
      </Box>
    </Box>
  );
}
